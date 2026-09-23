/** App 骨架：顶栏（品牌/书名/模型）+ 四栏工作台（活动栏 | 侧面板 | 聊天 | 可视化 | 资源管理器） */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { modeMeta, modelContextTokens, type ModeId, type ServerConfig, type WsEvent } from '@story-studio/shared'
import {
  classifyRoute,
  connectWs,
  createSpaceBook,
  fetchBackground,
  fetchBooks,
  fetchConfig,
  fetchSessions,
  fetchSessionMessages,
  fetchSpaces,
  fetchWorkspaceFile,
  isImagePath,
  newSessionId,
  openSpaceBook,
  rawFileUrl,
  type BackgroundInfo,
  type BookBrief,
  type SpaceBook,
} from './api.ts'
import { ChatPanel } from './chat/ChatPanel.tsx'
import type { RunLive } from './chat/RunLive.ts'
import { PetSettings } from './chat/PetSettings.tsx'
import { SoundSettings } from './chat/SoundSettings.tsx'
import type { PetState } from './chat/usePetState.ts'
import { WorkPanel } from './panels/WorkPanel.tsx'
import { WelcomePicker } from './panels/WelcomePicker.tsx'
import { ModelSettings } from './panels/SettingsPanel.tsx'
import { ActivityBar } from './components/ActivityBar.tsx'
import { SettingsModal, type SettingsTabId } from './components/SettingsModal.tsx'
import { GuideModal } from './components/GuideModal.tsx'
import { GuideTour } from './components/GuideTour.tsx'
import { BackgroundLayer } from './components/BackgroundLayer.tsx'
import { BackgroundSettings } from './components/BackgroundSettings.tsx'
import { StatusBar } from './components/StatusBar.tsx'
import { TopCapsule, type PetLive } from './components/TopCapsule.tsx'
import { FanficSettings } from './components/FanficSettings.tsx'
import { MusicPlayer } from './music/MusicPlayer.tsx'
import { MusicSettings } from './music/MusicSettings.tsx'
import { refreshMusicConfig } from './music/nowPlaying.ts'
import { LogPanel } from './components/LogPanel.tsx'
import { UsageStats } from './components/UsageStats.tsx'
import { SidePanel } from './components/SidePanel.tsx'
import { Explorer } from './components/Explorer.tsx'
import { Icon } from './components/Icon.tsx'

/** 模式 → 右侧默认视图（讨论看资料、创作看工作流、导入看向导、优化看选章、审稿/市场看报告、同人与人面板） */
const MODE_DEFAULT_VIEW: Record<ModeId, 'workflow' | 'reader' | 'cards' | 'tracking' | 'import' | 'polish' | 'report' | 'fanfic'> = {
  discuss: 'cards',
  write: 'workflow',
  import: 'import',
  polish: 'polish',
  preview: 'reader',
  market: 'report',
  review: 'report',
  fanfic: 'fanfic',
  calibrate: 'report',
}

const MODE_DEFAULT_DOC: Record<ModeId, '大纲' | '设定' | '追踪'> = {
  discuss: '设定',
  write: '追踪',
  import: '追踪',
  polish: '追踪',
  preview: '大纲',
  market: '大纲',
  review: '大纲',
  fanfic: '设定',
  calibrate: '大纲',
}

/** 与 agent-core 同款的上下文粗估（CJK≈0.6 token/字、其余≈0.28 token/字符），仅作占位展示 */
function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return Math.round(cjk * 0.6 + (text.length - cjk) * 0.28)
}

/** 载入历史会话时的上下文占用估算：各消息 parts 序列化后的字符粗估 */
function estimateMessagesTokens(messages: Array<{ parts?: unknown }>): number {
  return messages.reduce((acc, m) => acc + estimateTokens(JSON.stringify(m.parts ?? [])), 0)
}

/**
 * 用户自定义强调/高亮色 → 覆写 CSS 变量（--accent/--gold 同色族 + 派生 hover/soft）。
 * inline style 优先级高于 html[data-theme] 规则 → 自定义色在所有主题下都生效；
 * 空串 = 清除覆盖、跟随主题默认色。避免用该色时与 text 对比度过低，hover 往白提亮 16%。
 */
function applyAccentColor(hex: string): void {
  const root = document.documentElement
  const vars = ['--accent', '--accent-hover', '--accent-soft', '--gold', '--gold-soft'] as const
  if (!hex) {
    for (const v of vars) root.style.removeProperty(v)
    return
  }
  const full = hex.length === 4 ? `#${hex.slice(1).split('').map((c) => c + c).join('')}` : hex
  const n = parseInt(full.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lighten = (t: number) =>
    `#${[r, g, b].map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('')}`
  root.style.setProperty('--accent', full)
  root.style.setProperty('--accent-hover', lighten(0.16))
  root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.13)`)
  root.style.setProperty('--gold', full)
  root.style.setProperty('--gold-soft', `rgba(${r},${g},${b},0.14)`)
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [mode, setMode] = useState<ModeId>('discuss')
  const [sessionId, setSessionId] = useState(newSessionId)
  /** 会话 id 的实时引用：WS 回调闭包只捕获首渲染值，切换后靠 ref 判断当前会话 */
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  /** 启动引导：先选创作目录再进入主界面 */
  const [picked, setPicked] = useState(false)
  const [pickBusy, setPickBusy] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [wsEvent, setWsEvent] = useState<WsEvent | null>(null)
  const [toast, setToast] = useState<{ text: string; action?: { label: string; onClick: () => void } } | null>(null)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; mode: string; updatedAt: string }>>([])
  const [pendingLoad, setPendingLoad] = useState<{ id: string; messages: UIMessage[] } | null>(null)
  /** 导入向导等面板 → ChatPanel 的代理发送通道（nonce 触发） */
  const [pendingPrompt, setPendingPrompt] = useState<{ text: string; nonce: number } | null>(null)
  /** 资源管理器右键「添加到对话」：@路径 引用插入聊天输入框（经 ChatPanel 透传 Composer，不自动发送） */
  const [composerInsert, setComposerInsert] = useState<{ path: string; nonce: number } | null>(null)
  /** 书架（多书管理）——并入设置中心「书架」页签 */
  const [books, setBooks] = useState<{ parent: string; books: BookBrief[] }>({ parent: '', books: [] })
  const [switching, setSwitching] = useState(false)
  /** 书架内联新建小说（复用欢迎页 handleCreate 链路） */
  const [creatingBook, setCreatingBook] = useState(false)
  const [newBookParent, setNewBookParent] = useState('')
  const [newBookTitle, setNewBookTitle] = useState('')
  /** 空间目录（欢迎页数据：最近创作记录） */
  const [spaces, setSpaces] = useState<{ spaceDir: string; books: SpaceBook[] }>({ spaceDir: '', books: [] })
  /** 调试日志（WS log 事件，最近 300 条）——底部日志面板（状态栏计数同步变化） */
  const [logs, setLogs] = useState<Array<{ level: string; msg: string; at: string }>>([])
  /** 状态栏：日志面板开合 + WS 连接状态 + Agent 实时阶段（WS agent:status） */
  const [logPanelOpen, setLogPanelOpen] = useState(false)
  const [wsConnected, setWsConnected] = useState(true)
  /** 顶栏胶囊的 Agent 段：与桌宠同源的 13 态仲裁结果（ChatPanel onPetLive 上报） */
  const [petLive, setPetLive] = useState<PetLive>({ state: 'idle' as PetState, elapsed: 0 })
  /** 上下文弹窗数据（WS agent:usage）：最新快照 + 会话级缓存命中率累计 */
  const [ctxSnap, setCtxSnap] = useState<Extract<WsEvent, { type: 'agent:usage' }> | null>(null)
  const ctxTotalsRef = useRef({ input: 0, cacheRead: 0 })
  const ctxPrevRef = useRef<Extract<WsEvent, { type: 'agent:usage' }> | null>(null)
  const [ctxInfo, setCtxInfo] = useState<{ last: number; cap: number } | null>(null)
  /** 模型容量（来自 /api/config 的 modelId）：首条 usage 到达前也显示「上下文 0/容量」 */
  useEffect(() => {
    if (config && !ctxInfo && !ctxSnap) setCtxInfo({ last: 0, cap: modelContextTokens(config.modelId) })
  }, [config, ctxInfo, ctxSnap])
  /** 会话切换时重置上下文进度条与轮内累计：estLast=载入会话的预估占用；新会话传 0 */
  const applyContextReset = (estLast: number) => {
    ctxTotalsRef.current = { input: 0, cacheRead: 0 }
    ctxPrevRef.current = null
    setCtxSnap(null)
    setCtxInfo({ last: estLast, cap: ctxInfo?.cap ?? (config ? modelContextTokens(config.modelId) : 0) })
  }
  /** 日志错误/警告计数（状态栏 ⊗⚠ 数字实时驱动） */
  const logErrCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs])
  const logWarnCount = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs])
  /** 书切换信号（nonce 触发 WorkPanel/ChatPanel 全量刷新） */
  const [bookSwitched, setBookSwitched] = useState(0)
  /** 统一设置中心：null = 关闭，否则为当前页签（模型 / 书架 / 外观） */
  const [settingsTab, setSettingsTab] = useState<SettingsTabId | null>(null)
  /** 创作指南：教学弹窗 + 分步教学指引（Tour） */
  const [guideOpen, setGuideOpen] = useState(false)
  const [tourOn, setTourOn] = useState(false)
  /** 交付卡「去阅读本章」跳章信号（ChatPanel → WorkPanel：切到阅读视图并定位章节） */
  const [chapterJump, setChapterJump] = useState<{ chapter: number; nonce: number } | null>(null)
  /** Agent 运行实时快照（ChatPanel → WorkPanel 工作流视图：当前工具/动作/章号/步骤） */
  const [runLive, setRunLive] = useState<RunLive | null>(null)
  /** 主题（深夜书房=深色默认 / 宣纸白昼=米黄浅色 / 纯白=中性白 / 极光黑=冷色暗黑）：持久化 + 同步标题栏 */
  const [theme, setTheme] = useState<'dark' | 'light' | 'white' | 'aurora'>(() => {
    const t = localStorage.getItem('theme')
    return t === 'light' || t === 'white' || t === 'aurora' ? t : 'dark'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
    const overlay =
      theme === 'light'
        ? { color: '#f6f1e7', symbolColor: '#6b6152' }
        : theme === 'white'
          ? { color: '#ffffff', symbolColor: '#55555e' }
          : theme === 'aurora'
            ? { color: '#11171b', symbolColor: '#86a0a6' }
            : { color: '#1a1713', symbolColor: '#a89d8a' }
    void window.storyDesktop?.setTitleBarOverlay?.(overlay).catch(() => {})
  }, [theme])

  /** 自定义强调/高亮色（洒金/朱砂同色族）：localStorage 持久化，空=跟随主题默认色 */
  const [accentColor, setAccentColor] = useState<string>(() => {
    const c = localStorage.getItem('accentColor')
    return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : ''
  })
  useEffect(() => {
    localStorage.setItem('accentColor', accentColor)
    applyAccentColor(accentColor)
  }, [accentColor])

  /** 动态背景（全页面视频；设置中心「外观」上传 ≤100M MP4，存服务端 .local/background.mp4）。
   *  虚化程度 0-1（localStorage 持久化，滑杆实时调，页面 blur = 值×36px） */
  const [bg, setBg] = useState<BackgroundInfo>({ enabled: false, size: 0 })
  const [bgBlur, setBgBlur] = useState(() => {
    const raw = localStorage.getItem('bg-blur')
    if (raw === null) return 0.5
    const v = Number(raw)
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5
  })
  const changeBgBlur = (v: number): void => {
    setBgBlur(v)
    localStorage.setItem('bg-blur', String(v))
  }
  useEffect(() => {
    fetchBackground().then(setBg).catch(() => {})
  }, [])
  /** 播放器列表弹层开合：桌面端据此隐藏原生浏览器视图（原生视图永远盖住 DOM，不隐藏会压住弹层）。
   *  注意：必须先声明后用——此前三连快存曾让 vite 缓存到「引用了未声明状态」的中间态，进工作区即 ReferenceError 整树卸载 */
  const [musicListOpen, setMusicListOpen] = useState(false)
  /** 工作台四栏：侧面板（按钮开合；触发 Agent 任务自动收）+ 资源管理器折叠 + 可拖拽对话栏宽度 */
  const [sideOpen, setSideOpen] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(true)
  const [workFile, setWorkFile] = useState<{ path: string; content: string } | null>(null)
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const chatRef = useRef<HTMLElement | null>(null)
  const sessionsInFlight = useRef(false)
  const sessionsDirty = useRef(false)
  const wideScreen = useMediaWide()

  // Ctrl+Alt+N 全局开新会话（与侧面板「＋ 新会话」按钮同源）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        void newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** 拖拽调宽：mousedown 启动，全局 move/up 跟随；对话栏 280px 起步，可视化栏保底 460px；双击恢复默认 */
  const startChatResize = (e: React.MouseEvent) => {
    if (!wideScreen || !workspaceRef.current || !chatRef.current) return
    e.preventDefault()
    const wsRect = workspaceRef.current.getBoundingClientRect()
    const chatLeft = chatRef.current.getBoundingClientRect().left
    const explorerW = explorerOpen ? 244 : 0
    const min = 280
    const max = Math.max(min + 80, wsRect.width - explorerW - 460)
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(max, Math.max(min, ev.clientX - wsRect.left - (sideOpen ? 212 : 0)))
      setChatWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('col-resizing')
    void chatLeft
  }

  const sendToAgent = useCallback((text: string) => {
    setPendingPrompt({ text, nonce: Date.now() })
  }, [])

  const refreshBooks = useCallback(async () => {
    try {
      setBooks(await fetchBooks())
    } catch {
      setBooks({ parent: '', books: [] })
    }
  }, [])

  const doSwitchBook = async (dir: string) => {
    if (switching) return
    setSwitching(true)
    try {
      // 书架聚合了空间目录最近记录（绝对路径）与父目录邻居书 → 统一走 /api/spaces/open
      const r = await openSpaceBook(dir)
      if (r.switched) {
        setSettingsTab(null)
        setBookSwitched(Date.now())
        setConfig(await fetchConfig())
        void refreshSessions()
        showToast(`已切换到《${r.bookTitle}》`)
      } else {
        setSettingsTab(null)
        showToast(`当前已是《${r.bookTitle}》`)
      }
    } catch (e) {
      showToast(`切书失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSwitching(false)
    }
  }

  /** 打开书目录（欢迎页：最近记录 / 目录树选择） */
  const handleOpen = async (path: string) => {
    setPickBusy(true)
    setPickError(null)
    try {
      const r = await openSpaceBook(path)
      showToast(r.switched ? `已打开《${r.bookTitle}》` : `当前已是《${r.bookTitle}》`)
      setSpaces((prev) => ({ ...prev, books: r.books }))
      setConfig(await fetchConfig())
      setBookSwitched(Date.now())
      void refreshBooks()
      void refreshSessions()
      setPicked(true)
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e))
    } finally {
      setPickBusy(false)
    }
  }

  /** 新建小说（欢迎页）：父目录 + 书名 → 建工程骨架并切换 */
  const handleCreate = async (parentPath: string, title: string) => {
    setPickBusy(true)
    setPickError(null)
    try {
      const r = await createSpaceBook(parentPath, title)
      showToast(`已新建《${r.bookTitle}》`)
      setSpaces((prev) => ({ ...prev, books: r.books }))
      setConfig(await fetchConfig())
      setBookSwitched(Date.now())
      void refreshBooks()
      void refreshSessions()
      setPicked(true)
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e))
    } finally {
      setPickBusy(false)
    }
  }

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig(null))
    // 桌面应用：顶栏作为窗口拖拽区（titleBarOverlay 模式）
    if (window.storyDesktop) document.body.classList.add('desktop-titlebar')
    void refreshBooks()
    // 音乐源配置快照（右岛/右下角播放器共用）
    void refreshMusicConfig()
    fetchSpaces()
      .then((s) => setSpaces(s))
      .catch(() => {})
    void refreshSessions()
    // 必须返回取消订阅：React StrictMode 开发态双挂载，若不清理会残留两条 WS 连接，
    // 日志抽屉每条事件收两次（表现为所有日志行 ×2，服务端实际只执行一次）
    return connectWs((ev) => {
      setWsEvent(ev)
      if (ev.type === 'mode:switched') {
        setMode(ev.mode)
        showToast(`已切换到「${modeMeta(ev.mode).label}」模式${ev.reason ? `（${ev.reason}）` : ''}`)
      } else if (ev.type === 'file:changed' && ev.kind === 'setting' && ev.path.startsWith('设定/头像/')) {
        // 头像文件变更（Agent webai_draw 落盘 / 多端上传）→ 广播前端头像刷新（CardsView/RelNet 已监听）
        window.dispatchEvent(new CustomEvent('relnet:avatar'))
      } else if (ev.type === 'book:switched') {
        // 多端切书同步（另一标签页/Agent 侧触发）：刷新本地视图
        setBookSwitched(Date.now())
        setConfig(null)
        fetchConfig().then(setConfig).catch(() => setConfig(null))
      } else if (ev.type === 'agent:status') {
        // Agent 实时阶段 → 顶栏胶囊（细粒度 13 态由 ChatPanel 的 usePetState 仲裁后经 onPetLive 上报）
      } else if (ev.type === 'agent:usage') {
        // 任务完成（最终快照 durationMs>0）→ 广播「最近任务记录」刷新（设置统计页监听 usage:new-record）
        if (ev.durationMs > 0) window.dispatchEvent(new CustomEvent('usage:new-record'))
        // 已切到别的会话：旧会话仍在飞的流的用法事件不驱动当前进度条
        if (ev.sessionId && ev.sessionId !== sessionIdRef.current) return
        // 最近一次模型输入 / 容量 → 状态栏上下文进度条 + 点击弹窗（构成/命中率）
        const base = ctxPrevRef.current
        if (base && ev.calls < base.calls) ctxPrevRef.current = null // 新一轮：重置轮内基线
        const prev = ctxPrevRef.current
        ctxTotalsRef.current = {
          input: ctxTotalsRef.current.input + (ev.inputTokens - (prev?.inputTokens ?? 0)),
          cacheRead: ctxTotalsRef.current.cacheRead + (ev.cacheReadTokens - (prev?.cacheReadTokens ?? 0)),
        }
        ctxPrevRef.current = ev
        setCtxSnap(ev)
        setCtxInfo({ last: ev.lastInputTokens, cap: ev.capacity.tokens })
      } else if (ev.type === 'log') {
        // 服务端聊天日志 → 底部日志面板（状态栏计数同步变化）
        setLogs((prev) => [...prev.slice(-299), { level: ev.level, msg: ev.msg, at: ev.at }])
      }
    }, setWsConnected)
  }, [])

  const refreshSessions = useCallback(async () => {
    // 并发节流：流式期间 onMessages 会高频触发（每新消息一次），若每次都发 fetch，
    // 大量 /api/sessions 请求堆积 → ERR_INSUFFICIENT_RESOURCES（连接打爆，资源管理器/可视化连带失败）。
    // inflight + dirty：同时最多 1 个在飞请求，期间到达的刷新请求合并为 1 次补刷
    if (sessionsInFlight.current) {
      sessionsDirty.current = true
      return
    }
    sessionsInFlight.current = true
    try {
      setSessions(await fetchSessions())
      sessionsDirty.current = false
    } catch {
      // 网络瞬断不打断 UI（历史会话列表保持旧数据）
    } finally {
      sessionsInFlight.current = false
      if (sessionsDirty.current) {
        sessionsDirty.current = false
        void refreshSessions()
      }
    }
  }, [])

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (text: string, action?: { label: string; onClick: () => void }) => {
    setToast({ text, ...(action ? { action } : {}) })
    // 连续 toast 时旧定时器会提前清掉新 toast 并堆积：先清旧再新建
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3200)
  }

  /** 发送前自动模式建议（本地规则，未命中保持当前；await 保证本轮请求就带新模式）。
   *  同时作为「触发 Agent 任务」的唯一收口（聊天输入/问答表单/外部面板代理发送都走这里）：
   *  任务触发即自动收起侧面板给内容区让位，不影响用户随后手动展开。 */
  const preRoute = async (text: string): Promise<{ switched: boolean; used?: string }> => {
    setSideOpen(false)
    const prevMode = mode
    const result = await classifyRoute(text, mode)
    if (result?.decision) {
      setMode(result.decision.mode)
      // 自动切换（含 LLM 兜底命中）展示原因 + 命中层 + 3s 内可一键撤销，防误路由
      const usedLabel =
        result.used === 'local'
          ? '本地意图识别'
          : result.used === 'llm-cache'
            ? '深度识别·缓存'
            : result.used === 'llm'
              ? '深度识别'
              : '规则命中'
      showToast(`已切换到「${modeMeta(result.decision.mode).label}」模式 — ${result.decision.reason}（${usedLabel}）`, {
        label: '撤销',
        onClick: () => setMode(prevMode),
      })
      return { switched: true, used: result.used }
    }
    return { switched: false, used: result?.used }
  }

  const onMessages = useCallback(
    (messages: UIMessage[]) => {
      if (messages.length > 0) void refreshSessions()
    },
    [refreshSessions],
  )

  const loadSession = async (id: string) => {
    try {
      const s = await fetchSessionMessages(id)
      setSessionId(id)
      setMode(s.mode)
      setPendingLoad({ id, messages: s.messages as UIMessage[] })
      // 进度条立即反映载入会话的上下文占用（真实值等下一轮 usage，先用同款估算口径）
      applyContextReset(estimateMessagesTokens(s.messages as Array<{ parts?: unknown }>))
      showToast(`已载入会话：${s.title}`)
    } catch {
      showToast('会话载入失败')
    }
  }

  /** 资源管理器文件 → 送入「文档编辑」页只读展示；图片文件 → 大图灯箱预览（突破 1MB 文本限制） */
  const [workImage, setWorkImage] = useState<{ path: string } | null>(null)
  const openFilePreview = async (path: string) => {
    if (isImagePath(path)) {
      setWorkImage({ path })
      return
    }
    try {
      const content = await fetchWorkspaceFile(path)
      if (content === null) {
        showToast('文件读取失败或超出 1MB 限制')
        return
      }
      setWorkFile({ path, content })
    } catch {
      showToast('文件读取失败')
    }
  }

  /** 资源管理器正文章节「手机阅读」：解析章号 → 跳转可视化阅读器定位（复用交付卡跳章信号） */
  const readChapterFromPath = (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? ''
    const m = /^第\s*0*(\d+)\s*章/.exec(name)
    if (!m) {
      showToast('无法识别章节号（文件名需为 第NNN章_标题.md）')
      return
    }
    setChapterJump({ chapter: Number.parseInt(m[1]!, 10), nonce: Date.now() })
  }

  // 图片灯箱：Escape 关闭
  useEffect(() => {
    if (!workImage) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setWorkImage(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workImage])

  const newChat = () => {
    setSessionId(newSessionId())
    setMode('discuss')
    setPendingLoad(null)
    applyContextReset(0)
    showToast('已开启新会话')
  }

  // 书切换 → 开新会话（旧会话属于旧书的工作区存储）
  useEffect(() => {
    if (bookSwitched === 0) return
    setSessionId(newSessionId())
    setPendingLoad(null)
    applyContextReset(0)
    void refreshBooks()
  }, [bookSwitched, refreshBooks])

  // 启动引导：先选/建创作目录再进入主界面
  if (!picked) {
    return (
      <div className="app">
        {bg.enabled && <BackgroundLayer url={`/api/background/video?t=${bg.size}`} blur={bgBlur} />}
        <WelcomePicker
          books={spaces.books}
          busy={pickBusy}
          error={pickError}
          onCreate={(parentPath, title) => void handleCreate(parentPath, title)}
          onOpen={(path) => void handleOpen(path)}
        />
        {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.onClick()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      </div>
    )
  }

  return (
    <div className="app">
      {bg.enabled && <BackgroundLayer url={`/api/background/video?t=${bg.size}`} blur={bgBlur} />}
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">OpenNovel</span>
          <button
            type="button"
            className="book-name book-name-btn"
            title="点击打开书架切换书籍"
            onClick={() => {
              setSettingsTab((v) => (v === 'books' ? null : 'books'))
              void refreshBooks()
            }}
          >
            《{config?.bookTitle ?? '…'}》
          </button>
        </div>
        <TopCapsule
          mode={mode}
          onMode={setMode}
          petLive={petLive}
          connected={wsConnected}
          onConfigure={() => setSettingsTab('music')}
        />
      </header>

      {settingsTab !== null && (
        <SettingsModal
          active={settingsTab}
          onTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          tabs={[
            {
              id: 'books',
              label: '书架',
              icon: 'book-open',
              desc: '切换 / 新建',
              content: (
                <>
                  {books.books.length === 0 && !creatingBook && (
                    <div className="session-empty">
                      书架为空——书目录可以在任意位置，请通过欢迎页「打开小说文件夹」或「最近创作」进入。
                    </div>
                  )}
                  {creatingBook ? (
                    <div className="books-create">
                      <label className="fc-field">
                        <span className="fc-label">存放目录</span>
                        <input
                          className="fc-input"
                          value={newBookParent}
                          placeholder="书工程所在的父目录"
                          onChange={(e) => setNewBookParent(e.target.value)}
                        />
                      </label>
                      <label className="fc-field">
                        <span className="fc-label">书名</span>
                        <input
                          className="fc-input"
                          value={newBookTitle}
                          placeholder="输入书名，创建标准 oh-story 工程骨架并切换"
                          autoFocus
                          onChange={(e) => setNewBookTitle(e.target.value)}
                        />
                      </label>
                      <div className="books-create-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={!newBookParent.trim() || !newBookTitle.trim() || pickBusy}
                          onClick={() =>
                            void handleCreate(newBookParent.trim(), newBookTitle.trim()).then(() => {
                              setCreatingBook(false)
                              setNewBookTitle('')
                            })
                          }
                        >
                          {pickBusy ? '创建中…' : '创建'}
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => { setCreatingBook(false); setNewBookTitle('') }}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="btn-ghost books-create-btn" onClick={() => {
                      setNewBookParent(books.parent || '')
                      setCreatingBook(true)
                    }}>
                      ＋ 新建小说
                    </button>
                  )}
                  {books.books.map((b) => (
                    <button
                      key={b.dir}
                      type="button"
                      className={`session-item${b.current ? ' current' : ''}`}
                      disabled={b.current || switching}
                      title={b.dir}
                      onClick={() => void doSwitchBook(b.dir)}
                    >
                      <span className="session-title">
                        {b.current ? <Icon name="book-open" size={14} /> : <Icon name="folder" size={14} />}
                        {b.title}
                      </span>
                      <span className="session-meta">{b.current ? '当前' : switching ? '切换中…' : '点击切换'}</span>
                    </button>
                  ))}
                </>
              ),
            },
            {
              id: 'usage',
              label: '统计',
              icon: 'chart-bar',
              desc: 'Token 消耗',
              content: <UsageStats />,
            },
            {
              id: 'fanfic',
              label: '同人',
              icon: 'dna',
              desc: '搜索源配置',
              content: <FanficSettings />,
            },
            {
              id: 'music',
              label: '音乐',
              icon: 'volume',
              desc: '音乐源 / 登录',
              content: <MusicSettings />,
            },
            {
              id: 'appearance',
              label: '外观',
              icon: 'palette',
              desc: '主题 / 桌宠 / 提醒',
              content: (
                <>
                  <div className="theme-cards">
                  <button
                    type="button"
                    className={`theme-card${theme === 'dark' ? ' on' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    <span className="theme-swatch swatch-dark" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-card-info">
                      <b>深夜书房</b>
                      <i>暖黑纸墨 · 默认主题</i>
                    </span>
                    {theme === 'dark' && <span className="theme-card-check">✓</span>}
                  </button>
                  <button
                    type="button"
                    className={`theme-card${theme === 'light' ? ' on' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    <span className="theme-swatch swatch-light" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-card-info">
                      <b>宣纸白昼</b>
                      <i>米黄浅色 · 暖纸护眼</i>
                    </span>
                    {theme === 'light' && <span className="theme-card-check">✓</span>}
                  </button>
                  <button
                    type="button"
                    className={`theme-card${theme === 'aurora' ? ' on' : ''}`}
                    onClick={() => setTheme('aurora')}
                  >
                    <span className="theme-swatch swatch-aurora" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-card-info">
                      <b>极光黑</b>
                      <i>冷色暗黑 · 极光青绿</i>
                    </span>
                    {theme === 'aurora' && <span className="theme-card-check">✓</span>}
                  </button>
                  <button
                    type="button"
                    className={`theme-card${theme === 'white' ? ' on' : ''}`}
                    onClick={() => setTheme('white')}
                  >
                    <span className="theme-swatch swatch-white" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-card-info">
                      <b>纯白</b>
                      <i>白色主题 · 中性极简</i>
                    </span>
                      {theme === 'white' && <span className="theme-card-check">✓</span>}
                  </button>
                </div>
                  <div className="accent-picker">
                    <div className="accent-picker-head">
                      <b>强调 / 高亮色</b>
                      <i>按钮与高亮文字统一换色；留空跟随当前主题</i>
                    </div>
                    <div className="accent-picker-row">
                      <input
                        type="color"
                        className="accent-picker-input"
                        value={accentColor || '#d0a75a'}
                        onChange={(e) => setAccentColor(e.target.value)}
                        aria-label="自定义强调/高亮色"
                      />
                      <span className="accent-picker-value">{accentColor ? accentColor : '跟随主题（洒金）'}</span>
                      {accentColor && (
                        <button type="button" className="accent-picker-reset" onClick={() => setAccentColor('')}>
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                  <BackgroundSettings bg={bg} blur={bgBlur} onChanged={setBg} onBlurChange={changeBgBlur} />
                  <PetSettings />
                  <SoundSettings />
                </>
              ),
            },
            {
              id: 'models',
              label: '模型',
              icon: 'gear',
              desc: 'Provider / Key',
              content: (
                <ModelSettings
                  onSaved={() => {
                    void fetchConfig()
                      .then(setConfig)
                      .catch(() => setConfig(null))
                  }}
                />
              ),
            },
          ]}
        />
      )}

      {/* 创作指南：教学弹窗（文档）+ 分步教学指引（聚光圈选，可在运行中随时开启） */}
      {guideOpen && (
        <GuideModal
          onClose={() => setGuideOpen(false)}
          onStartTour={() => {
            setGuideOpen(false)
            setTourOn(true)
          }}
        />
      )}
      {tourOn && <GuideTour onFinish={() => setTourOn(false)} />}

      <main className="workspace" ref={workspaceRef}>
        <div className="left-rail">
          <ActivityBar
            mode={mode}
            onMode={setMode}
            sideCollapsed={!sideOpen}
            onToggleSide={() => {
              // 手动开合（无自动收起计时）；展开后保持展开，直到再次手动或触发 Agent 任务
              setSideOpen((v) => !v)
            }}
            explorerOpen={explorerOpen}
            onToggleExplorer={() => setExplorerOpen((v) => !v)}
            onBooks={() => {
              setSettingsTab((v) => (v === 'books' ? null : 'books'))
              void refreshBooks()
            }}
            onGuide={() => setGuideOpen(true)}
            onSettings={() => setSettingsTab((v) => (v === 'models' ? null : 'models'))}
          />
          <SidePanel
            mode={mode}
            onMode={setMode}
            sessions={sessions}
            currentSessionId={sessionId}
            onLoadSession={(id) => void loadSession(id)}
            collapsed={!sideOpen}
            onNewSession={() => void newChat()}
          />
        </div>
        <section
          className="layout-chat"
          ref={chatRef}
          style={wideScreen && chatWidth ? { flex: `0 0 ${chatWidth}px` } : undefined}
        >
          <ChatPanel
            sessionId={sessionId}
            mode={mode}
            onMessages={onMessages}
            pendingLoad={pendingLoad}
            pendingPrompt={pendingPrompt}
            onBeforeSend={preRoute}
            wsEvent={wsEvent}
            models={config?.models}
            activeModelId={config?.activeModelId}
            composerInsert={composerInsert}
            reasoningEfforts={config?.reasoningEfforts}
            workspace={config?.workspace}
            onPetLive={setPetLive}
            onJumpChapter={(ch) => setChapterJump({ chapter: ch, nonce: Date.now() })}
            onRunLive={setRunLive}
          />
        </section>
        {wideScreen && (
          <div
            className="splitter"
            title="拖拽调整宽度 · 双击恢复默认"
            onMouseDown={startChatResize}
            onDoubleClick={() => setChatWidth(null)}
          />
        )}
        <section className="layout-panel">
          <WorkPanel
            wsEvent={wsEvent}
            bookSwitched={bookSwitched}
            defaultView={MODE_DEFAULT_VIEW[mode]}
            defaultDocKey={MODE_DEFAULT_DOC[mode]}
            onSendToAgent={sendToAgent}
            openFile={workFile}
            onConsumeFile={() => setWorkFile(null)}
            covered={settingsTab !== null || musicListOpen}
            jumpSignal={chapterJump}
            runLive={runLive}
            modelLabel={config?.modelId ?? null}
          />
          {/* 日志面板：只在可视化栏内弹出（状态栏按钮触发），不压缩聊天列 */}
          {logPanelOpen && (
            <LogPanel logs={logs} onClose={() => setLogPanelOpen(false)} onClear={() => setLogs([])} />
          )}
        </section>
        {explorerOpen && config && (
          <Explorer
            key={config.workspace}
            workspace={config.workspace}
            bookTitle={config.bookTitle}
            wsEvent={wsEvent}
            onOpenFile={(p) => void openFilePreview(p)}
            onReadChapter={readChapterFromPath}
            onCollapse={() => setExplorerOpen(false)}
            onInsertToChat={(p) => setComposerInsert({ path: p, nonce: Date.now() })}
          />
        )}
        {!explorerOpen && config && (
          <button
            type="button"
            className="explorer-reveal"
            title="展开资源管理器"
            onClick={() => setExplorerOpen(true)}
          >
            资源管理器
          </button>
        )}
      </main>

      <StatusBar
        connected={wsConnected}
        ctxInfo={ctxInfo}
        ctxSnap={ctxSnap}
        ctxAvgHit={ctxTotalsRef.current.input > 0 ? ctxTotalsRef.current.cacheRead / ctxTotalsRef.current.input : 0}
        errCount={logErrCount}
        warnCount={logWarnCount}
        logsOpen={logPanelOpen}
        onToggleLogs={() => setLogPanelOpen((v) => !v)}
        onBooks={() => {
          setSettingsTab((v) => (v === 'books' ? null : 'books'))
          void refreshBooks()
        }}
        onSettings={() => setSettingsTab((v) => (v === 'models' ? null : 'models'))}
      />

      {/* 右下角黑胶音乐播放器（样式复刻 音乐播放.md；音频跨面板存活） */}
      <MusicPlayer onListOpenChange={setMusicListOpen} />

      {/* 工作区图片灯箱（资源管理器点击图片文件 → 原图预览） */}
      {workImage && (
        <div className="img-lightbox" onClick={() => setWorkImage(null)}>
          <img src={rawFileUrl(workImage.path)} alt={workImage.path} />
          <div className="img-lightbox-name">{workImage.path}</div>
        </div>
      )}

      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.onClick()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** ≥1101px 才启用拖拽调宽（窄屏两翼已收纳，宽度交给堆叠布局） */
function useMediaWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1101px)').matches)
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1101px)')
    const fn = (e: MediaQueryListEvent) => setWide(e.matches)
    m.addEventListener('change', fn)
    return () => m.removeEventListener('change', fn)
  }, [])
  return wide
}
