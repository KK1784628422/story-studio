/**
 * Agent浏览器面板（桌面化 Electron）：占位区域 + 把坐标发给主进程 setBounds，
 * 主进程把内置 WebContentsView 精确盖在占位区上——画面原生嵌入，非 screencast/canvas。
 * - 首页态（about:blank）原生视图隐藏，露出网页 AI 快捷卡片（GLM/DeepSeek/Qwen/混元），点击直达
 * - 工具条：后退/前进/刷新/首页 + 当前网址显示；导航状态由主进程 did-navigate 事件推送
 * - 非桌面环境（纯浏览器打开）显示引导提示；切离本面板时隐藏原生视图
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon.tsx'
import type { EmbeddedNavState } from '../desktop.d.ts'

/** 内置浏览器可视状态（CDP 探活） */
interface EmbeddedStatus {
  available: boolean
  port: number | null
}

/** 网页 AI 快捷卡片（首页点选直达） */
const AI_CARDS: Array<{ label: string; host: string; url: string; hue: string }> = [
  { label: 'GLM 智谱清言', host: 'chatglm.cn', url: 'https://chatglm.cn/', hue: '#3b82f6' },
  { label: 'DeepSeek', host: 'deepseek.com', url: 'https://www.deepseek.com/', hue: '#4b6bfb' },
  { label: 'Qwen 通义千问', host: 'qianwen.com', url: 'https://www.qianwen.com/', hue: '#8b5cf6' },
  { label: '混元 腾讯', host: 'aistudio.tencent.com', url: 'https://aistudio.tencent.com/', hue: '#0ea5e9' },
]

export function EmbeddedPane({
  covered = false,
  control = null,
}: {
  covered?: boolean
  /** 浏览器操控状态：'agent'=agent/脚本操控中（绿光圈）；'human'=需要人工操作（红光圈爆闪） */
  control?: 'agent' | 'human' | null
}): React.JSX.Element {
  const holderRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<EmbeddedStatus | null>(null)
  const [nav, setNav] = useState<EmbeddedNavState | null>(null)
  const [url, setUrl] = useState('')
  const isDesktop = typeof window !== 'undefined' && !!window.storyDesktop
  const isHome = !nav || isHomeUrl(nav.url)

  // 查询内置浏览器 CDP 端口（探活 + 展示）
  useEffect(() => {
    let alive = true
    fetch('/api/embedded/cdp-port', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { available: false, port: null }))
      .then((d) => alive && setStatus(d as EmbeddedStatus))
      .catch(() => alive && setStatus({ available: false, port: null }))
    return () => {
      alive = false
    }
  }, [])

  /** 导航状态：初始拉一次 + 订阅主进程推送 */
  useEffect(() => {
    if (!isDesktop) return
    void window.storyDesktop!.embeddedNav().then(setNav).catch(() => {})
    return window.storyDesktop!.onEmbeddedNavState(setNav)
  }, [isDesktop])

  /** 把占位 div 的屏幕坐标发给主进程（原生视图盖上来）；首页态或占位过小 = 隐藏（露出卡片）。
   *  与上次发送值一致时跳过（轮询路径防抖）。 */
  const lastSentRef = useRef<string>('')
  /** nav 的 ref（syncBounds 回调内读取最新值，避免回调身份变化打断订阅） */
  const navRef = useRef<EmbeddedNavState | null>(null)
  const syncBounds = useCallback(() => {
    if (!isDesktop) return
    const el = holderRef.current
    if (!el) return
    const hide = () => {
      if (lastSentRef.current !== '') {
        lastSentRef.current = ''
        void window.storyDesktop!.embeddedSetBounds(null)
      }
    }
    // 被全屏覆盖（书架/日志抽屉/设置面板等模态）时原生视图在 DOM 之上会盖住弹层——
    // 此时隐藏原生视图，覆盖结束（covered=false）后 effect 重跑再恢复显示
    if (covered) {
      hide()
      return
    }
    const r = el.getBoundingClientRect()
    if (r.width > 40 && r.height > 40 && !isHomeUrl(navRef.current?.url)) {
      const next = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
      if (next === lastSentRef.current) return
      lastSentRef.current = next
      void window.storyDesktop!.embeddedSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    } else {
      hide()
    }
  }, [isDesktop, covered])
  useEffect(() => {
    navRef.current = nav
    syncBounds()
  }, [nav, syncBounds])

  // 挂载 + 窗口 resize + 占位区尺寸变化（ResizeObserver）+ 轮询比对（纯位置变化，如侧栏折叠推挤）时同步
  useEffect(() => {
    if (!isDesktop) return
    syncBounds()
    const onResize = () => syncBounds()
    window.addEventListener('resize', onResize)
    // 布局可能晚一帧稳定（侧栏动画），补两次同步
    const t1 = setTimeout(syncBounds, 120)
    const t2 = setTimeout(syncBounds, 400)
    const ro = new ResizeObserver(syncBounds)
    if (holderRef.current) ro.observe(holderRef.current)
    const iv = setInterval(syncBounds, 400)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(t1)
      clearTimeout(t2)
      ro.disconnect()
      clearInterval(iv)
      // 卸载（切离本面板）时隐藏原生视图
      lastSentRef.current = ''
      void window.storyDesktop?.embeddedSetBounds(null)
    }
  }, [isDesktop, syncBounds])

  const doNav = () => {
    const u = normalizeUrl(url)
    if (u && isDesktop) void window.storyDesktop!.embeddedNavigate(u)
  }
  const navAction = (action: 'back' | 'forward' | 'reload' | 'home') => {
    if (isDesktop) void window.storyDesktop!.embeddedNavAction(action)
  }

  if (!isDesktop) {
    return (
      <div className="embedded-pane">
        <div className="embedded-empty">
          <Icon name="monitor" size={22} />
          <div className="embedded-empty-title">Agent浏览器仅在桌面应用中可用</div>
          <div className="embedded-empty-sub">
            当前是纯浏览器模式。桌面应用（Electron）里，这里内嵌一个 Agent 专属的真实浏览器：
            扫榜/网页 AI 的页面在这里打开并可视化，可人工接管登录，且绝不动你的系统浏览器。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="embedded-pane">
      <div className="embedded-toolbar">
        <span className={`agent-dot ${status?.available ? 'on' : 'off'}`} title={status?.available ? `Agent浏览器 CDP :${status.port}` : 'Agent浏览器未就绪'} />
        <button type="button" className="brow-btn" disabled={!nav?.canBack} title="后退" onClick={() => navAction('back')}>←</button>
        <button type="button" className="brow-btn" disabled={!nav?.canForward} title="前进" onClick={() => navAction('forward')}>→</button>
        <button type="button" className="brow-btn" disabled={!nav || isHomeUrl(nav.url)} title="刷新" onClick={() => navAction('reload')}>↻</button>
        <button type="button" className="brow-btn" disabled={isHome} title="回到首页（网页 AI 快捷卡片）" onClick={() => navAction('home')}>⌂</button>
        <input
          className="brow-url"
          placeholder={nav && !isHomeUrl(nav.url) ? nav.url : '输入网址回车，或点下方卡片快速打开网页 AI'}
          value={url}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doNav()
          }}
        />
        <button type="button" className="brow-btn go" onClick={doNav} title="在 Agent浏览器打开">前往</button>
        <button type="button" className="brow-btn" onClick={syncBounds} title="重新对齐画面（布局变化后）">
          <Icon name="shuffle" size={13} /> 对齐
        </button>
        {control === 'agent' && (
          <span className="agent-driving-tag" title="Agent 正在操控这个浏览器页面——请不要关闭它或切换标签页">
            <span className="pulse-dot" /> Agent 操控中
          </span>
        )}
        {control === 'human' && (
          <span className="agent-driving-tag danger" title="需要人工操作（登录/滑块等）——Agent 已暂停等待，请在画面中完成操作">
            <span className="pulse-dot" /> ⚠ 需要人工操作 · Agent 已暂停
          </span>
        )}
      </div>
      {/* 占位区：非首页时主进程把原生视图盖在这里；首页时露出快捷卡片 */}
      <div
        ref={holderRef}
        className={`embedded-holder${control === 'agent' ? ' agent-driving' : control === 'human' ? ' human-needed' : ''}`}
        onMouseUp={syncBounds}
      >
        {status && !status.available ? (
          <div className="embedded-holder-hint">Agent浏览器连接中…（CDP 端口未就绪）</div>
        ) : isHome ? (
          <div className="agent-home">
            <div className="agent-home-title">网页 AI 快速访问</div>
            <div className="agent-home-sub">点击卡片在 Agent浏览器打开（登录一次长期复用）；也可在上方输入任意网址</div>
            <div className="agent-cards">
              {AI_CARDS.map((c) => (
                <button key={c.url} type="button" className="agent-card" onClick={() => void window.storyDesktop!.embeddedNavigate(c.url)}>
                  <span className="agent-card-badge" style={{ background: c.hue }}>{c.label[0]}</span>
                  <span className="agent-card-body">
                    <span className="agent-card-name">{c.label}</span>
                    <span className="agent-card-host">{c.host}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 是否首页（about:blank / 空） */
function isHomeUrl(url: string | undefined): boolean {
  return !url || url === 'about:blank'
}

/** 补协议 + 去空白；非网址退化为必应搜索 */
function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(s)) return `https://${s}`
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`
}
