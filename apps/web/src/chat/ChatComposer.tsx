/**
 * ChatComposer：输入栏（模型/思考 +「+」功能菜单 + 附件 + @文件引用 + 网页AI胶囊 + 发送/停止）。
 *
 * 「+」功能菜单（可扩展数组）：
 *  - 添加附件：图片 → 多模态图片理解（需配置多模态模型；data URL 仅本轮注入，不落历史）
 *  - 引用工作区文件：@ 关键字过滤选择，选中插入「@绝对路径」文本（Agent 用 Read 读取，省 token）
 *  - 调用网页AI创作：开启「网页AI」胶囊（显式标记通道 B），发送时自动前置触发词
 *  - 后续功能只需向 MENU_ITEMS 追加一项
 *
 * 交互约定：
 *  - @ 选择器打开时 Enter 优先补全高亮项（↑↓ 换选），不发送；Esc 关闭回输入框
 *  - 「+」菜单 Esc 关闭、点击外部关闭，焦点归还按钮；粘贴截图直接进附件
 *  - 发送防抖：submittingRef 同帧拦截双 Enter；路由期间文字保留可见（sending 锁输入）
 *  - 超限/异常用内联提示条（4s 自动消失），不打断输入
 *
 * 拖拽：资源管理器文件行（text/x-story-file）→ @路径引用；系统图片文件 → 附件。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchDocs, fetchSpaceTree } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

export interface ComposerSendOpts {
  /** 网页 AI 通道：发送时自动前置「用网页AI」触发词 */
  webAi?: boolean
  /** 网页 AI 站点展示名（如「千问」），拼进触发词让 Agent 传 site */
  webAiSiteLabel?: string
  /** 网页 AI 站点内模型（如「Qwen3.8-Max」），拼进触发词让 Agent 传 model */
  webAiModel?: string
  /** 图片附件（data URL）——仅本轮注入，不落历史 */
  images?: string[]
}

interface Props {
  busy: boolean
  /** 路由进行中（true：文字保留、按钮转圈、输入锁定；与 busy 的停止按钮区分） */
  sending?: boolean
  /** 书工作区绝对路径（@ 引用文件的数据源） */
  workspace?: string
  onSend: (text: string, opts?: ComposerSendOpts) => void | Promise<void>
  onStop: () => void
  models: Array<{ id: string; label: string; modelId: string; supportsImages?: boolean; free?: boolean }>
  /** 激活 Provider id（输入栏未手动切换时的默认；决定图片附件默认可用性） */
  activeModelId?: string
  /** 资源管理器右键「添加到对话」：nonce 变化时把 @路径 引用插入输入框（不自动发送） */
  insertFile?: { path: string; nonce: number } | null
  efforts: Array<{ id: string; label: string }>
  onModelChange: (m: string) => void
  onEffortChange: (e: string) => void
  /** 「完全允许」开关状态（undefined = 隐藏，如优化模式）；状态与自动放行逻辑在 ChatPanel */
  autoAllow?: boolean
  onToggleAutoAllow?: () => void
}

/** 图片附件体积上限（data URL base64 膨胀约 1.33×；8MB 源图 ≈ 11MB data URL） */
const MAX_IMG_BYTES = 8 * 1024 * 1024
/** 附件数量上限（多模态请求体体积与模型图像数限制兜底） */
const MAX_ATTACHMENTS = 6
/** @ 文件树递归深度/数量上限（防超大工作区卡死） */
const TREE_MAX_DEPTH = 8
const TREE_MAX_FILES = 600
/** @ 选择器一次最多渲染的条目（配合关键字过滤，避免长列表卡顿） */
const AT_VISIBLE = 80

const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}\\${name}`

/** 网页AI生图 · 风格标签（可选；不选=写实电影人像默认） */
const AVATAR_STYLES = ['写实电影人像', '国风工笔', '动漫插画', '水墨写意', '古装摄影'] as const

/** 网页AI创作 · 站点与可选模型（与 packages/tools/src/askai/sites/ 适配器保持一致） */
const WEBAI_SITES: Array<{ id: string; label: string; models: string[]; defaultModel: string }> = [
  { id: 'glm', label: '智谱清言', models: [], defaultModel: '' },
  { id: 'qwen', label: '千问', models: ['Qwen3.8-Max', 'Qwen3.7-Max', 'Qwen3.7-千问', 'Qwen3.6-Flash'], defaultModel: 'Qwen3.8-Max' },
]

/** 「+」菜单项：后续功能在此追加 */
const MENU_ITEMS = [
  { key: 'attach', label: '添加附件（图片）', desc: '多模态图片理解' },
  { key: 'at', label: '引用工作区文件', desc: '@ 关键字选择' },
  { key: 'webai', label: '调用网页AI创作', desc: '免费生成通道 · 显式开启' },
  { key: 'avatar', label: '网页AI生图（人物头像）', desc: '豆包生成 · 自动配到角色' },
] as const

type MenuKey = (typeof MENU_ITEMS)[number]['key']

interface Attachment {
  id: string
  name: string
  dataUrl: string
}

export function ChatComposer({
  busy,
  sending,
  workspace,
  onSend,
  onStop,
  models,
  activeModelId,
  insertFile,
  efforts,
  onModelChange,
  onEffortChange,
  autoAllow,
  onToggleAutoAllow,
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('max')
  const taRef = useRef<HTMLTextAreaElement>(null)
  /** @ 引用高亮叠层：与 textarea 同字体排版，在其后画彩色标签底（textarea 保持原生输入/IME/光标） */
  const chipLayerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 「+」菜单
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)

  // 附件（图片）
  const [attachments, setAttachments] = useState<Attachment[]>([])

  /** 当前模型是否支持图片输入：跟随输入栏选中 Provider（未选 = 激活 Provider）的配置；
   *  未配置/未知 Provider 一律视为不支持——避免向纯文本模型发送 file part 导致 400 */
  const curSupportsImages =
    models.find((m) => m.id === (model || activeModelId))?.supportsImages === true
  /** 当前模型是否为免费池（多账号 key 轮询，429 自动切换）——输入栏显示 FREE 徽标 */
  const curModel = models.find((m) => m.id === (model || activeModelId))
  const curFree = curModel?.free === true
  /** 切到不支持图片的模型时清空待发附件（残留附件会在发送时被拦） */
  useEffect(() => {
    if (!curSupportsImages) setAttachments((prev) => (prev.length > 0 ? [] : prev))
  }, [curSupportsImages])

  // 内联提示（超限/跳过等，不打断输入）
  const [hint, setHint] = useState<string | null>(null)
  const hintTimerRef = useRef(0)
  const showHint = (msg: string) => {
    setHint(msg)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(null), 4000)
  }
  useEffect(() => () => window.clearTimeout(hintTimerRef.current), [])

  // 网页 AI 胶囊（通道 B 显式标记）
  const [webAi, setWebAi] = useState(false)
  const [webAiSite, setWebAiSite] = useState('glm')
  const [webAiModel, setWebAiModel] = useState('')
  const webAiSiteDef = WEBAI_SITES.find((s) => s.id === webAiSite) ?? WEBAI_SITES[0]
  const webAiSiteLabel = webAiSiteDef.label
  const webAiModelValue = webAiSiteDef.models.length > 0 ? webAiModel || webAiSiteDef.defaultModel : ''

  // 网页AI生图（人物头像）：面板 + 角色列表（fetchDocs 设定→角色组）+ 已选人物/风格/提示词版本（1.0 七段式 / 2.0 电影摄影级 / 3.0 三段流水线）
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [avatarChars, setAvatarChars] = useState<string[] | null>(null)
  const [avChar, setAvChar] = useState('')
  const [avStyle, setAvStyle] = useState('')
  const [avVer, setAvVer] = useState<'1' | '2' | '3'>('3')

  // @ 文件引用
  const [atOpen, setAtOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atIndex, setAtIndex] = useState(0)
  const [files, setFiles] = useState<Array<{ name: string; path: string }> | null>(null)
  const atListRef = useRef<HTMLDivElement>(null)
  const treeCache = useRef<Map<string, { dirs: string[]; files: string[] }>>(new Map())

  // 拖拽高亮
  const [dragOver, setDragOver] = useState(false)

  /** 发送防抖：同帧双 Enter / 期间重复提交拦截（路由 busy 由 sending prop 与上层 ref 兜底） */
  const submittingRef = useRef(false)

  /** 已插入引用：显示名 → 完整路径（输入框只显示文件名，发送前展开回绝对路径，Agent 端无感知） */
  const refMapRef = useRef<Map<string, string>>(new Map())
  // 工作区切换后旧映射作废
  useEffect(() => {
    refMapRef.current.clear()
  }, [workspace])

  /** 显示名：优先「文件名+格式」；与其他书目录重名时退回工作区相对路径，保唯一性 */
  const displayTokenFor = (path: string): string => {
    const name = path.split(/[\\/]/).pop() ?? path
    const hit = refMapRef.current.get(name)
    if (hit === undefined || hit === path) return name
    const ws = workspace?.replace(/[\\/]+$/, '')
    if (ws && path.toLowerCase().startsWith(ws.toLowerCase())) {
      return path.slice(ws.length).replace(/^[\\/]+/, '')
    }
    return path
  }

  /** 发送前把 @显示名 展开回完整路径（Agent 直接 Read，不需要猜位置；边界规则与 @ 触发一致） */
  const expandRefs = (v: string): string => {
    const map = refMapRef.current
    if (map.size === 0) return v
    let out = ''
    let last = 0
    for (const m of v.matchAll(/@([^\s@]+)/g)) {
      const i = m.index ?? 0
      if (i > 0 && /[a-z0-9]/i.test(v[i - 1]!)) continue
      const full = map.get(m[1]!)
      if (full === undefined) continue
      out += v.slice(last, i) + '@' + full
      last = i + m[0].length
    }
    return last === 0 ? v : out + v.slice(last)
  }

  // Provider 列表就绪后：未选 / 选中项已删除 → 自动落到第一个（模型与思考档同规则，保证 UI 与实发一致）
  useEffect(() => {
    if (models.length === 0) return
    if (!models.some((m) => m.id === model)) {
      setModel(models[0].id)
      onModelChange(models[0].id)
    }
  }, [models, model])
  useEffect(() => {
    if (efforts.length === 0) return
    if (!efforts.some((e) => e.id === effort)) {
      setEffort(efforts[0].id)
      onEffortChange(efforts[0].id)
    }
  }, [efforts, effort])

  // 点击外部 / Escape 关闭「+」菜单（关闭后焦点归还按钮）
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        plusRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const autoResize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(200, Math.max(44, ta.scrollHeight))}px`
  }

  /** 文本变化后统一重算高度（发送清空、@插入、逐字输入都走这里）：setText 后同步调 autoResize
   *  读到的还是旧 DOM 内容，高度会被旧文本钉住——必须在 React 提交后再量 */
  useLayoutEffect(() => {
    autoResize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // ---------- 附件（图片） ----------
  const pickImages = (list: FileList | null) => {
    if (!list || list.length === 0) return
    if (!curSupportsImages) {
      showHint('当前模型未开启图片输入：请在「模型设置 → 支持图片输入」勾选后使用')
      return
    }
    const imgs = Array.from(list).filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      showHint(`附件最多 ${MAX_ATTACHMENTS} 张，已忽略新增`)
      return
    }
    if (imgs.length > room) showHint(`附件上限 ${MAX_ATTACHMENTS} 张，本次只加入前 ${room} 张`)
    for (const f of imgs.slice(0, room)) {
      if (f.size > MAX_IMG_BYTES) {
        showHint(`图片「${f.name}」超过 8MB，已跳过`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') return
        setAttachments((prev) =>
          prev.length >= MAX_ATTACHMENTS
            ? prev
            : [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, dataUrl: reader.result as string }],
        )
      }
      reader.readAsDataURL(f)
    }
  }

  // ---------- @ 文件引用 ----------
  const collectFiles = async (dir: string, depth: number, acc: Array<{ name: string; path: string }>) => {
    if (depth > TREE_MAX_DEPTH || acc.length >= TREE_MAX_FILES) return
    let entry = treeCache.current.get(dir)
    if (!entry) {
      try {
        entry = await fetchSpaceTree(dir)
        treeCache.current.set(dir, entry)
      } catch {
        return
      }
    }
    for (const f of entry.files) {
      if (acc.length >= TREE_MAX_FILES) return
      acc.push({ name: f, path: joinPath(dir, f) })
    }
    for (const d of entry.dirs) {
      await collectFiles(joinPath(dir, d), depth + 1, acc)
    }
  }

  const openAtPicker = async () => {
    setAtQuery('')
    setAtIndex(0)
    setAtOpen(true)
    if (files || !workspace) return
    const acc: Array<{ name: string; path: string }> = []
    await collectFiles(workspace, 0, acc)
    setFiles(acc)
  }

  const filteredFiles = useMemo(() => {
    if (!files) return []
    const q = atQuery.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
  }, [files, atQuery])

  /** @ 选择器可见条目与高亮索引（↑↓ 导航 + Enter 补全） */
  const visibleFiles = filteredFiles.slice(0, AT_VISIBLE)
  const hlIdx = Math.min(atIndex, Math.max(0, visibleFiles.length - 1))

  // 过滤词变化收敛高亮；高亮项滚动进可视区
  useEffect(() => setAtIndex(0), [atQuery])
  useEffect(() => {
    atListRef.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' })
  }, [atIndex, atQuery, atOpen])

  /** 全文 @token 扫描（与 atTokenAt 同边界规则：@ 前非字母数字、token 不含空格/@）→ 渲染标签底 */
  const chipSegments = useMemo(() => {
    const out: Array<{ text: string; chip: boolean }> = []
    let last = 0
    for (const m of text.matchAll(/@([^\s@]+)/g)) {
      const i = m.index ?? 0
      if (i > 0 && /[a-z0-9]/i.test(text[i - 1]!)) continue
      if (i > last) out.push({ text: text.slice(last, i), chip: false })
      out.push({ text: m[0], chip: true })
      last = i + m[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), chip: false })
    return out
  }, [text])

  /** 一次 Backspace 删除整个 @引用：光标在 token 内/尾即整体删；刚插入的「@path 」连尾随空格一起删 */
  const chipAtCursor = (v: string, cursor: number): { start: number; end: number } | null => {
    for (const m of v.matchAll(/@([^\s@]+)/g)) {
      const i = m.index ?? 0
      if (i > 0 && /[a-z0-9]/i.test(v[i - 1]!)) continue
      const end = i + m[0].length
      if (cursor > i && cursor <= end) return { start: i, end }
      if (cursor === end + 1 && v[end] === ' ') return { start: i, end: end + 1 }
    }
    return null
  }

  /** 待恢复光标位（@ 引用整体删除后）：React 提交新 value 后同步落位，不用 rAF（后台标签页会节流导致竞态） */
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaretRef.current == null) return
    const ta = taRef.current
    if (ta) {
      const pos = pendingCaretRef.current
      ta.focus()
      ta.setSelectionRange(pos, pos)
      autoResize()
    }
    pendingCaretRef.current = null
  })

  /** textarea 滚动时同步高亮叠层（内容超过 200px 上限后两者一起滚，保证标签不错位） */
  const syncChipScroll = () => {
    const ta = taRef.current
    if (ta && chipLayerRef.current) chipLayerRef.current.scrollTop = ta.scrollTop
  }

  /** 光标前的 @token（@后到光标、不含空格）——命中即弹选择器 */
  const atTokenAt = (value: string, cursor: number): { token: string; start: number } | null => {
    const before = value.slice(0, cursor)
    const m = /@([^\s@]*)$/.exec(before)
    if (!m) return null
    // @ 前是字母/数字（如邮箱 user@x）→ 不误触
    if (m.index > 0 && /[a-z0-9]/i.test(before[m.index - 1]!)) return null
    return { token: m[1]!, start: m.index }
  }

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    const cursor = e.target.selectionStart ?? v.length
    setText(v)
    autoResize()
    if (atOpen || atTokenAt(v, cursor)) {
      const tk = atTokenAt(v, cursor)
      if (tk) {
        setAtQuery(tk.token)
        setAtOpen(true)
      } else {
        setAtOpen(false)
      }
    }
  }

  const insertAtPath = (path: string) => {
    // 输入框只显示「文件名+格式」（重名冲突退回工作区相对路径），发送前再展开回完整路径
    const token = displayTokenFor(path)
    refMapRef.current.set(token, path)
    const ta = taRef.current
    if (!ta) return
    const cursor = ta.selectionStart ?? text.length
    const tk = atTokenAt(text, cursor)
    let next: string
    let nextCursor: number
    if (tk) {
      next = `${text.slice(0, tk.start)}@${token} ${text.slice(cursor)}`
      nextCursor = tk.start + token.length + 2
    } else {
      next = `${text.slice(0, cursor)}@${token} ${text.slice(cursor)}`
      nextCursor = cursor + token.length + 2
    }
    setText(next)
    setAtOpen(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(nextCursor, nextCursor)
      autoResize()
    })
  }

  /** 资源管理器右键「添加到对话」：nonce 变化 → 复用 @ 引用插入（与拖拽同一入口，不自动发送） */
  const lastInsertNonce = useRef(0)
  useEffect(() => {
    if (!insertFile || insertFile.nonce === lastInsertNonce.current) return
    lastInsertNonce.current = insertFile.nonce
    insertAtPath(insertFile.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertFile])

  // ---------- 拖拽 ----------
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const fromExplorer = e.dataTransfer.getData('text/x-story-file')
    if (fromExplorer) {
      insertAtPath(fromExplorer)
      return
    }
    if (e.dataTransfer.files.length > 0) {
      pickImages(e.dataTransfer.files)
    }
  }

  // ---------- 发送 ----------
  const submit = async () => {
    if (submittingRef.current) return
    const t = text.trim()
    if ((!t && attachments.length === 0) || busy || sending) return
    if (attachments.length > 0 && !curSupportsImages) {
      showHint('当前模型未开启图片输入：请在「模型设置 → 支持图片输入」勾选后使用')
      return
    }
    submittingRef.current = true
    try {
      await onSend(expandRefs(t), {
        ...(webAi ? { webAi: true } : {}),
        ...(webAi && webAiSiteLabel ? { webAiSiteLabel } : {}),
        ...(webAi && webAiModelValue ? { webAiModel: webAiModelValue } : {}),
        ...(attachments.length > 0 ? { images: attachments.map((a) => a.dataUrl) } : {}),
      })
      setText('')
      setAttachments([])
      setWebAi(false)
      // 高度复位由上方 [text] 布局 effect 在 DOM 提交后统一处理，这里同步量到的还是旧内容
      taRef.current?.focus()
    } finally {
      submittingRef.current = false
    }
  }

  const runMenu = (key: MenuKey) => {
    setMenuOpen(false)
    if (key === 'attach') {
      fileRef.current?.click()
    } else if (key === 'at') {
      void openAtPicker()
    } else if (key === 'webai') {
      setWebAi(true)
      taRef.current?.focus()
    } else if (key === 'avatar') {
      // 打开生图面板：拉取 设定/角色/ 人物列表（null=加载中；[] 无角色卡）
      setAvChar('')
      setAvStyle('')
      setAvVer('3')
      setAvatarOpen(true)
      setAvatarChars(null)
      void fetchDocs()
        .then((sections) => {
          const sec = sections.find((s) => s.key === '设定')
          const chars =
            sec?.groups
              .find((g) => g.group === '角色')
              ?.cards.filter((c) => c.name.endsWith('.md'))
              .map((c) => c.name.replace(/\.md$/, '')) ?? []
          setAvatarChars(chars)
        })
        .catch(() => setAvatarChars([]))
    }
  }

  /** 确认生图指令：触发词 + 人物名（必须）+ 风格标签（可选）+ 提示词版本 → 直接发送给 Agent */
  const submitAvatar = () => {
    const name = avChar.trim()
    if (!name) return
    const style = avStyle ? `，风格：${avStyle}` : ''
    setAvatarOpen(false)
    if (avVer === '3') {
      void onSend(`用网页AI生图3.0为人物「${name}」生成人物头像${style}。先读该人物的角色卡，按 story-webai-avatar-3 技能的三段流水线执行：审美筛查（静帧四问）→ Creative Meeting 会议纪要与七大模块产出（展示给我）→ 转译组装豆包化提示词并展示中文对照，然后调豆包生图并自动配置头像。`)
    } else if (avVer === '2') {
      void onSend(`用网页AI生图2.0为人物「${name}」生成人物头像${style}。先读该人物的角色卡，按 story-webai-avatar-2 技能的电影摄影级流程（读其 references 模板做静默摄影决策，生成摄影笔记式提示词）生成生图提示词并展示中文对照，然后调豆包生图并自动配置头像。`)
    } else {
      void onSend(`用网页AI生图为人物「${name}」生成人物头像${style}。先读该人物的角色卡，按七段式模板生成生图提示词并展示中文对照，然后调豆包生图并自动配置头像。`)
    }
  }

  return (
    <div
      className={`prompt-input${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* 附件（图片）缩略图区 */}
      {attachments.length > 0 && (
        <div className="composer-attach-row">
          {attachments.map((a) => (
            <div key={a.id} className="composer-attach" title={a.name}>
              <img src={a.dataUrl} alt={a.name} className="composer-attach-img" />
              <span className="composer-attach-name">{a.name}</span>
              <button
                type="button"
                className="composer-attach-x"
                title="移除附件"
                aria-label={`移除附件 ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 网页 AI 胶囊（通道 B 显式标记）：站点 + 模型下拉，选择随发送写进触发词 */}
      {webAi && (
        <div className="composer-webai">
          <Icon name="spark" size={13} />
          <span>网页AI</span>
          <select
            className="composer-webai-select"
            aria-label="选择网页AI站点"
            value={webAiSite}
            disabled={sending}
            onChange={(e) => {
              setWebAiSite(e.target.value)
              const next = WEBAI_SITES.find((s) => s.id === e.target.value)
              setWebAiModel(next?.defaultModel ?? '')
            }}
          >
            {WEBAI_SITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {webAiSiteDef.models.length > 0 && (
            <select
              className="composer-webai-select"
              aria-label="选择网页AI模型"
              value={webAiModelValue}
              disabled={sending}
              onChange={(e) => setWebAiModel(e.target.value)}
            >
              {webAiSiteDef.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="composer-webai-x" title="取消网页AI通道" aria-label="取消网页AI通道" onClick={() => setWebAi(false)}>
            ✕
          </button>
        </div>
      )}

      {/* 内联提示（超限/跳过，4s 自动消失） */}
      {hint && (
        <div className="composer-hint" role="status">
          {hint}
        </div>
      )}

      <div className="composer-main">
        <div className="composer-row">
          <div className="composer-plus-wrap" ref={menuRef}>
            <button
              ref={plusRef}
              type="button"
              className={`composer-plus${menuOpen ? ' on' : ''}`}
              title="更多功能"
              aria-label="更多功能"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              disabled={sending}
              onClick={() => setMenuOpen((v) => !v)}
            >
              +
            </button>
            {menuOpen && (
              <div className="composer-menu" role="menu">
                {/* 图片附件项仅当前模型支持图片输入时展示（Provider 配置开关） */}
                {MENU_ITEMS.filter((it) => it.key !== 'attach' || curSupportsImages).map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className="composer-menu-item"
                    role="menuitem"
                    onClick={() => runMenu(it.key)}
                  >
                    <span className="composer-menu-label">{it.label}</span>
                    <span className="composer-menu-desc">{it.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="composer-input-wrap">
            {/* @ 引用标签底（纯视觉，文本本体仍在 textarea） */}
            <div className="composer-highlight" ref={chipLayerRef} aria-hidden>
              {chipSegments.map((s, i) =>
                s.chip ? (
                  <span key={i} className="composer-chip">
                    {s.text}
                  </span>
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )}
              {'\n'}
            </div>
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              aria-label="消息输入"
              placeholder={webAi ? '用网页AI…（描述创作需求，回车发送）' : '说点什么…（Enter 发送 / Shift+Enter 换行）'}
              disabled={sending}
              onChange={onTextChange}
              onScroll={syncChipScroll}
              onPaste={(e) => {
                // 粘贴截图直接进附件（文本粘贴不受影响）
                const fs = e.clipboardData?.files
                if (fs && fs.length > 0 && Array.from(fs).some((f) => f.type.startsWith('image/'))) {
                  e.preventDefault()
                  pickImages(fs)
                }
              }}
              onKeyDown={(e) => {
                // Backspace 命中 @ 引用 → 整体删除（IME 组合中不拦截）
                if (e.key === 'Backspace' && !e.nativeEvent.isComposing) {
                  const ta = e.currentTarget
                  const s = ta.selectionStart ?? 0
                  const en = ta.selectionEnd ?? 0
                  const hit = s === en && s > 0 ? chipAtCursor(text, s) : null
                  if (hit) {
                    e.preventDefault()
                    pendingCaretRef.current = hit.start
                    setText(text.slice(0, hit.start) + text.slice(hit.end))
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  // @ 选择器打开时 Enter 优先补全高亮文件，不发送
                  if (atOpen && visibleFiles.length > 0) insertAtPath(visibleFiles[hlIdx]!.path)
                  else void submit()
                  return
                }
                if (atOpen && visibleFiles.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  setAtIndex((i) =>
                    e.key === 'ArrowDown' ? Math.min(visibleFiles.length - 1, i + 1) : Math.max(0, i - 1),
                  )
                  return
                }
                if (e.key === 'Escape') {
                  if (atOpen) {
                    e.preventDefault()
                    setAtOpen(false)
                  } else if (avatarOpen) {
                    e.preventDefault()
                    setAvatarOpen(false)
                  } else if (menuOpen) {
                    e.preventDefault()
                    setMenuOpen(false)
                    plusRef.current?.focus()
                  }
                }
              }}
            />
          </div>
        </div>

        {/* 网页AI生图面板（人物头像）：必选人物 + 可选风格标签 → 发送生图指令 */}
        {avatarOpen && (
          <div className="composer-avatar" role="dialog" aria-label="网页AI生图（人物头像）">
            <div className="composer-avatar-head">
              <b>
                <Icon name="spark" size={13} /> 网页AI生图 · 人物头像
              </b>
              <span>豆包生成 → 自动配到「设定/头像/」，关系网即时刷新</span>
              <button
                type="button"
                className="composer-avatar-x"
                title="关闭"
                aria-label="关闭生图面板"
                onClick={() => setAvatarOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="composer-avatar-sec">
              <span className="composer-avatar-label">选择人物（必须）</span>
              <div className="composer-avatar-chars">
                {avatarChars === null ? (
                  <span className="composer-avatar-empty">正在加载角色卡…</span>
                ) : avatarChars.length === 0 ? (
                  <span className="composer-avatar-empty">
                    设定/角色/ 下没有角色卡——先在创作模式让 Agent 建角色，或直接在输入框对 Agent 说「为 XXX 生成头像」。
                  </span>
                ) : (
                  avatarChars.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`composer-avatar-char${avChar === n ? ' on' : ''}`}
                      onClick={() => setAvChar(n)}
                    >
                      {n}
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="composer-avatar-sec">
              <span className="composer-avatar-label">提示词版本（默认 3.0 三段流水线）</span>
              <div className="composer-avatar-chars">
                <button
                  type="button"
                  className={`composer-avatar-char style${avVer === '3' ? ' on' : ''}`}
                  title="三段流水线完整体：审美筛查 → Creative Meeting 七模块（决策展示）→ 转译组装（story-webai-avatar-3）"
                  onClick={() => setAvVer('3')}
                >
                  3.0 三段流水线
                </button>
                <button
                  type="button"
                  className={`composer-avatar-char style${avVer === '2' ? ' on' : ''}`}
                  title="电影摄影级：静默摄影决策 + 摄影笔记式提示词（story-webai-avatar-2）"
                  onClick={() => setAvVer('2')}
                >
                  2.0 电影摄影级
                </button>
                <button
                  type="button"
                  className={`composer-avatar-char style${avVer === '1' ? ' on' : ''}`}
                  title="经典版：七段式描述模板（story-webai-avatar + novel-character-prompt）"
                  onClick={() => setAvVer('1')}
                >
                  1.0 七段式
                </button>
              </div>
            </div>
            <div className="composer-avatar-sec">
              <span className="composer-avatar-label">风格标签（可选，默认写实电影人像）</span>
              <div className="composer-avatar-chars">
                {AVATAR_STYLES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`composer-avatar-char style${avStyle === s ? ' on' : ''}`}
                    onClick={() => setAvStyle(avStyle === s ? '' : s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="composer-avatar-foot">
              <span className="composer-avatar-hint">
                {avChar ? `将为「${avChar}」生成头像` : '请先选择一个人物'}
              </span>
              <div className="composer-avatar-actions">
                <button type="button" className="composer-avatar-cancel" onClick={() => setAvatarOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="composer-avatar-go"
                  disabled={!avChar}
                  title={avChar ? '发送生图指令给 Agent' : '先选择人物'}
                  onClick={submitAvatar}
                >
                  <Icon name="spark" size={12} /> 生成头像
                </button>
              </div>
            </div>
          </div>
        )}

        {/* @ 文件选择器（向上浮出，不挤压工具栏） */}
        {atOpen && (
          <div className="composer-at">
            <div className="composer-at-input">
              <span className="composer-at-prefix">@</span>
              <input
                value={atQuery}
                placeholder="输入关键字过滤文件…（↑↓ 选择 / Enter 补全 / Esc 关闭）"
                autoFocus
                aria-label="过滤工作区文件"
                onChange={(e) => setAtQuery(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && visibleFiles.length > 0) {
                    e.preventDefault()
                    setAtIndex((i) =>
                      e.key === 'ArrowDown' ? Math.min(visibleFiles.length - 1, i + 1) : Math.max(0, i - 1),
                    )
                  } else if (e.key === 'Enter' && visibleFiles.length > 0) {
                    e.preventDefault()
                    insertAtPath(visibleFiles[hlIdx]!.path)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setAtOpen(false)
                    taRef.current?.focus()
                  }
                }}
              />
            </div>
            <div className="composer-at-list" ref={atListRef}>
              {visibleFiles.length === 0 ? (
                <div className="composer-at-empty">
                  {files ? '无匹配文件' : '正在加载工作区文件…'}
                </div>
              ) : (
                visibleFiles.map((f, i) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`composer-at-item${i === hlIdx ? ' hl' : ''}`}
                    title={f.path}
                    onMouseEnter={() => setAtIndex(i)}
                    onClick={() => insertAtPath(f.path)}
                  >
                    <Icon name="file-text" size={13} />
                    <span className="composer-at-name">{f.name}</span>
                    <span className="composer-at-path">{f.path}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="prompt-toolbar">
          <div className="prompt-tools">
            {/* 完全允许开关：工具条最左（默认手动审批；优化模式隐藏——升华作者批准承载免检语义不能自动放行） */}
            {onToggleAutoAllow && (
              <button
                type="button"
                className={`chat-allow-chip${autoAllow ? ' on' : ''}`}
                onClick={onToggleAutoAllow}
                title={
                  autoAllow
                    ? '已开启：本会话 Write/Edit 审批自动放行（浏览器等高危操作仍手动确认）。点击关闭恢复逐个审批。'
                    : '一键完全允许：本会话的 Write/Edit 审批自动放行，无需逐个点击（默认手动审批；浏览器等高危操作仍手动确认）。'
                }
              >
                <Icon name={autoAllow ? 'check-circle' : 'wrench'} size={12} />
                {autoAllow ? '完全允许 · 已开启' : '完全允许'}
              </button>
            )}
            {models.length > 0 ? (
              <label className="prompt-select">
                <span className="prompt-select-label">模型</span>
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value)
                    onModelChange(e.target.value)
                  }}
                  disabled={busy}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {curFree && (
                  <span className="model-free-tag" title="免费池模型：多账号 key 自动轮询，触发 429 自动切换下一个，不中断对话">
                    FREE
                  </span>
                )}
              </label>
            ) : (
              <label className="prompt-select" title="请打开「模型设置」配置 API">
                <span className="prompt-select-label">模型</span>
                <select value="" disabled>
                  <option>暂无可用模型</option>
                </select>
              </label>
            )}
            <label className="prompt-select">
              <span className="prompt-select-label">思考</span>
              <select
                value={effort}
                onChange={(e) => {
                  setEffort(e.target.value)
                  onEffortChange(e.target.value)
                }}
                disabled={busy}
              >
                {efforts.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {busy ? (
            <button type="button" className="btn-stop" title="停止生成" aria-label="停止生成" onClick={onStop}>
              ■
            </button>
          ) : (
            <button
              type="button"
              className={`btn-send${sending ? ' sending' : ''}`}
              title={sending ? '正在识别意图…' : '发送（Enter）'}
              aria-label={sending ? '正在识别意图' : '发送'}
              onClick={() => void submit()}
              disabled={(!text.trim() && attachments.length === 0) || sending}
            >
              {sending ? <span className="send-spinner" /> : '↑'}
            </button>
          )}
        </div>
      </div>

      {/* 附件图片选择（隐藏 input） */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          pickImages(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
