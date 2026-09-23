/**
 * 内置浏览器管理：一个独立 WebContentsView（persist partition 独立登录态），承载扫榜可视化与后续网页 AI 创作。
 *
 * 【API 说明】Electron 30+ 起 BrowserView 已废弃（新版移除），必须用 WebContentsView +
 *   win.contentView.addChildView()。这就是此前「内置浏览器面板黑屏」的根因。
 *
 * CDP 说明（设计文档 §9 未决问题 1，已实测通过）：
 *   Electron 的 remote-debugging-port 是**应用级**的——在 app.ready 前经
 *   app.commandLine.appendSwitch('remote-debugging-port', port) 开启后，应用内
 *   所有视图的页面都暴露在同一 CDP 端点上，用 targetId 区分。
 *   agent 侧必须用 tab list 选中「内置浏览器」那个 target（非回环 URL），
 *   绝不能误操作主窗口（Web 前端，127.0.0.1）。targetId 锁定在 tools/脚本层做。
 */
import { BrowserWindow, WebContentsView, app } from 'electron'
import { getFreePort } from './net'

export interface EmbeddedBrowser {
  view: WebContentsView
  cdpPort: number
  /** 当前是否已附加到某个窗口并显示 */
  visible: boolean
}

/** Agent浏览器导航状态（前端工具条按此启停 后退/前进 按钮 + 显示当前网址） */
export interface EmbeddedNavState {
  url: string
  canBack: boolean
  canForward: boolean
}

let embedded: EmbeddedBrowser | null = null
/** 导航状态变化回调（ipc 装配时接主窗口 webContents.send 推给前端） */
let navListener: ((nav: EmbeddedNavState) => void) | null = null

/** 导航状态变化订阅（ipc.ts 调用；传 null 取消） */
export function setOnNavChanged(cb: ((nav: EmbeddedNavState) => void) | null): void {
  navListener = cb
}

/** 当前导航状态快照 */
export function embeddedNavSnapshot(): EmbeddedNavState {
  if (!embedded) return { url: '', canBack: false, canForward: false }
  const wc = embedded.view.webContents
  try {
    return { url: wc.getURL() ?? '', canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }
  } catch {
    return { url: '', canBack: false, canForward: false }
  }
}

/** 是否处于首页（about:blank：原生视图隐藏，露出前端快捷卡片） */
export function isEmbeddedHome(url: string): boolean {
  return !url || url === 'about:blank'
}

/** 导航动作（back/forward/reload/home）；home 回到快捷卡片首页 */
export function embeddedNavAction(action: 'back' | 'forward' | 'reload' | 'home'): void {
  if (!embedded) return
  const wc = embedded.view.webContents
  try {
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else wc.loadURL(HOME_URL).catch(() => {})
  } catch { /* 导航中/已销毁，忽略 */ }
}

/** 内置浏览器固定打开的首页（targetId 识别用：非回环 URL 的 target 即内置浏览器） */
const HOME_URL = 'about:blank'

/** 在 app.ready 之前调用：为整个应用选定 CDP 端口（应用级，见文件头说明） */
export function planCdpPort(): Promise<number> {
  return getFreePort(9333)
}

/** 注册应用级 CDP 开关（必须在 app.ready 前调用）。只绑本机回环，不对外暴露。 */
export function applyCdpSwitch(cdpPort: number): void {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
  // remote-allow-origins 用通配（appendSwitch 只接受单值）；本地回环 WS 由 agent-browser 客户端发起
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

/** 创建内置浏览器 WebContentsView（不显示；首次 setBounds 时才附加到窗口） */
export function createEmbeddedBrowser(cdpPort: number): EmbeddedBrowser {
  if (embedded) return embedded
  const view = new WebContentsView({
    webPreferences: {
      // persist partition：登录态落盘持久（userData/Partitions/embedded），扫榜/AI 站点登录一次长期复用
      partition: 'persist:embedded',
      // 安全：不开 node、保持 contextIsolation 默认
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  })
  view.webContents.loadURL(HOME_URL).catch(() => {})
  // 新窗口一律在本视图内打开（不弹系统浏览器）
  view.webContents.setWindowOpenHandler(({ url }) => {
    view.webContents.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  // 导航状态变化 → 推给前端（工具条 后退/前进 启停 + 当前网址 + 首页/页面切换）
  const emitNav = () => navListener?.(embeddedNavSnapshot())
  view.webContents.on('did-navigate', emitNav)
  view.webContents.on('did-navigate-in-page', emitNav)
  // 白屏自愈：渲染进程崩溃 / 加载失败不再卡死成白屏——记录并短延迟后重新加载（保持 CDP 可用）
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[desktop] Agent浏览器渲染进程异常（${details.reason}），1.2s 后自动重载`)
    setTimeout(() => {
      try {
        if (embedded?.view && !embedded.view.webContents.isDestroyed()) {
          embedded.view.webContents.reload()
        }
      } catch { /* 已销毁，忽略 */ }
    }, 1200)
  })
  view.webContents.on('did-fail-load', (_e, errCode, errDesc, validatedURL, isMainFrame) => {
    // 仅在主体页面失败时记日志（about:blank 等内嵌资源失败忽略，避免噪音）
    if (isMainFrame) console.error(`[desktop] Agent浏览器加载失败 code=${errCode} desc=${errDesc} url=${validatedURL}`)
  })
  embedded = { view, cdpPort, visible: false }
  console.log(`[desktop] Agent浏览器已创建（WebContentsView，CDP :${cdpPort}）`)
  return embedded
}

/** 把内置浏览器附加到窗口并盖在指定区域（前端占位 div 相对窗口内容区的坐标）。
 *  addChildView 幂等：视图已在父级则重排为最顶层，不在则加入——因此每次显示都必须调用，
 *  不能依赖「上次加过」的标记（否则 hide 后再 show 会因跳过重挂而永远黑屏）。 */
export function showEmbedded(
  win: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  if (!embedded) {
    console.warn('[desktop] showEmbedded 调用时内置浏览器尚未创建')
    return
  }
  try {
    win.contentView.addChildView(embedded.view)
    embedded.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    })
    embedded.visible = true
  } catch (e) {
    console.error('[desktop] 内置浏览器显示失败：', e)
  }
}

/** 隐藏内置浏览器（移出窗口但保 session，画面销毁、登录态保留） */
export function hideEmbedded(): void {
  if (!embedded) return
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.contentView.removeChildView(embedded.view) } catch { /* 忽略 */ }
  }
  embedded.visible = false
}

/** 导航内置浏览器（agent 之外的手动导航，如登录起点） */
export function navigateEmbedded(url: string): void {
  if (!embedded) return
  embedded.view.webContents.loadURL(url).catch((e) => console.error('[desktop] 内置浏览器导航失败：', e))
}

export function getEmbedded(): EmbeddedBrowser | null {
  return embedded
}
