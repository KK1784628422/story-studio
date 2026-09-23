/**
 * Electron 主进程入口：
 *  - 起 Fastify server（fork tsx 子进程跑现有 apps/server，零改 server 代码；dev 带 watch）
 *    【注意】server 只在这里起——dev:desktop 脚本不再单独起 server，否则双进程抢 8100
 *    （第二个 EADDRINUSE 崩溃，且 concurrently 那个会 autoOpen 弹系统浏览器）
 *  - 等就绪后建主窗口加载 Web 前端（开发：Vite dev :5173；生产：apps/web/dist/index.html）
 *  - 应用级 CDP 端口（app.ready 前 appendSwitch）+ 内置浏览器 WebContentsView（扫榜可视化/网页AI）
 *
 * 设计文档：桌面化-内置浏览器-落地设计.md §2/§3/§4
 */
import { BrowserWindow, Menu, app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { applyCdpSwitch, createEmbeddedBrowser, planCdpPort } from './embeddedBrowser'
import { registerIpc } from './ipc'

/** 仓库根（apps/desktop/dist → 上三级）。Electron 主进程为 CJS，用 __dirname */
const ROOT = resolve(__dirname, '..', '..', '..')
const isDev = !app.isPackaged
const VITE_DEV_URL = process.env.STORY_VITE_URL ?? 'http://127.0.0.1:5173'
const SERVER_PORT = Number(process.env.STORY_STUDIO_PORT ?? 8100)

let mainWindow: BrowserWindow | null = null
let serverChild: ChildProcess | null = null

/** 内置浏览器 CDP 端口文件（server/tools/扫榜脚本读取；项目 .local，不入 git） */
const CDP_PORT_FILE = join(ROOT, '.local', 'embedded-cdp-port')
function writeCdpPortFile(port: number): void {
  try {
    mkdirSync(join(ROOT, '.local'), { recursive: true })
    writeFileSync(CDP_PORT_FILE, String(port), 'utf8')
  } catch { /* 写失败不阻断 */ }
}
function clearCdpPortFile(): void {
  try { rmSync(CDP_PORT_FILE, { force: true }) } catch { /* 忽略 */ }
}

/* ---- CDP 端口：必须在 app.ready 前定好并 appendSwitch（应用级，见 embeddedBrowser.ts 头注释） ---- */
const cdpPortPromise = planCdpPort()
cdpPortPromise.then((port) => applyCdpSwitch(port))

/** 受限环境（无 GPU/沙箱子进程受限，如 CI、远程会话、部分自动化宿主）启动兜底：
 *  STORY_DESKTOP_NO_GPU=1 时禁用 GPU 进程与 Chromium 沙箱，避免
 *  「GPU process isn't usable. Goodbye」致命退出。正常桌面启动不要设置。 */
if (process.env.STORY_DESKTOP_NO_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

/** 启动 Fastify server（fork tsx CLI；dev = tsx watch 热重启，prod = 直接跑） */
function startServer(): void {
  const serverEntry = join(ROOT, 'apps', 'server', 'src', 'index.ts')
  const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const args = isDev ? ['watch', serverEntry] : [serverEntry]
  serverChild = spawn(process.execPath, [tsxCli, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], // 与 fork(…,{silent:true}) 等价的管道；无 IPC 需求故不用 fork
    // windowsHide：Electron 主进程是 GUI 无控制台，子进程 node/tsx 是控制台程序——
    // 不加 CREATE_NO_WINDOW 会让 Windows 为其新建黑色 cmd 窗口（网页版 server 跑在终端里
    // 子进程继承终端控制台所以不会弹，桌面版才有）。加了后整条子进程树都无窗口。
    windowsHide: true,
    env: {
      ...process.env,
      // 关键：process.execPath 在 Electron 主进程里是 electron 可执行文件（不是 node）——
      // fork 内部会自动注入 ELECTRON_RUN_AS_NODE 让子进程以纯 Node 运行；改用 spawn 后
      // 没有这份注入，必须显式带上，否则 electron.exe 会把 tsx cli.mjs 当 Electron 应用入口跑
      ELECTRON_RUN_AS_NODE: '1',
      STORY_STUDIO_AUTO_OPEN: 'false', // 桌面化：绝不开系统浏览器，由 Electron 窗口接管
      NODE_ENV: isDev ? 'development' : 'production',
    },
  })
  serverChild.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`))
  serverChild.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`))
  serverChild.on('exit', (code) => {
    console.error(`[desktop] server 子进程退出 code=${code}`)
    serverChild = null
  })
}

/** 轮询等待 server 就绪（窗口加载时 API 已可用，避免首屏请求空打） */
function waitForServer(port: number, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolvePromise) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1500 }, (res) => {
        res.resume()
        resolvePromise(res.statusCode === 200)
      })
      req.on('error', () => retry())
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - start > timeoutMs) return resolvePromise(false)
      setTimeout(attempt, 400)
    }
    attempt()
  })
}

function createWindow(): void {
  const isWindows = process.platform === 'win32'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Story Studio',
    // 暖黑纸墨（与前端 --bg 一致）；浅色主题经 IPC setTitleBarOverlay 运行时切换
    backgroundColor: '#0e0d0b',
    // Windows：隐藏标题栏文字，仅保留右上角原生 最小化/最大化/关闭（titleBarOverlay）；
    // 拖拽区由前端顶栏承接（body.desktop-titlebar 的 -webkit-app-region）。非 Windows 保持原生标题栏。
    // 初始配色 = 深色主题顶栏（渐变起色 --bg-panel #1a1713 + 副文字 --text-dim #a89d8a）
    ...(isWindows
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#1a1713', symbolColor: '#a89d8a', height: 52 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  })

  // Windows：去掉 File/Edit/View/Window 默认菜单（Electron 脚手架默认项，本项目无菜单需求）。
  // 文本框 Ctrl+C/V/X/Z 由 Chromium 原生处理不受影响；DevTools 快捷键在下方 before-input-event 兜底
  if (isWindows) {
    Menu.setApplicationMenu(null)
  }
  // DevTools 开关（F12 / Ctrl+Shift+I）——菜单移除后的兜底通道
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const isF12 = input.key === 'F12'
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (isF12 || isCtrlShiftI) {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // 生产：加载打包后的静态前端；开发：加载 Vite dev server（HMR）。
  // DevTools 不自动弹（用户反馈干扰）；需要时应用窗口里 Ctrl+Shift+I
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL).catch((e) => console.error('[desktop] 加载 Vite dev 失败：', e))
  } else {
    const indexHtml = join(ROOT, 'apps', 'web', 'dist', 'index.html')
    mainWindow.loadFile(indexHtml).catch((e) => console.error('[desktop] 加载 dist 失败：', e))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const cdpPort = await cdpPortPromise
    startServer()
    const serverUp = await waitForServer(SERVER_PORT)
    if (!serverUp) console.warn(`[desktop] server :${SERVER_PORT} 未在超时内就绪（窗口仍会打开，API 可能短暂不可用）`)
    createWindow()
    try {
      createEmbeddedBrowser(cdpPort)
    } catch (e) {
      console.error('[desktop] 内置浏览器创建失败（面板将不可用，主功能不受影响）：', e)
    }
    registerIpc(() => mainWindow)
    // 把内置浏览器 CDP 端口写到项目 .local，server 的 /api/embedded/cdp-port 与 tools/扫榜脚本据此连接
    writeCdpPortFile(cdpPort)
    console.log(`[desktop] 内置浏览器 CDP 端口：${cdpPort}（agent-browser --cdp ${cdpPort}，targetId 选中非回环 target）`)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    clearCdpPortFile()
    if (serverChild) {
      try { serverChild.kill() } catch { /* 忽略 */ }
      serverChild = null
    }
  })
}
