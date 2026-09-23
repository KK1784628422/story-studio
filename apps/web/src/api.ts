/** 前端 API 封装 + WS 客户端 */
import type {
  BookInfo,
  ChapterContent,
  DocSection,
  FanficFileGroup,
  FanficFicVolume,
  FanficProgress,
  FanficVolumeDetail,
  GateReport,
  ModeId,
  ServerConfig,
  SessionInfo,
  SnapshotInfo,
  TrackingPanelData,
  WsEvent,
} from '@story-studio/shared'

export interface RouteDecision {
  mode: ModeId
  reason: string
}

export async function fetchConfig(): Promise<ServerConfig> {
  const r = await fetch('/api/config', { cache: 'no-store' })
  if (!r.ok) throw new Error(`config ${r.status}`)
  return r.json()
}

export async function fetchBook(): Promise<BookInfo> {
  const r = await fetch('/api/book', { cache: 'no-store' })
  if (!r.ok) throw new Error(`book ${r.status}`)
  return r.json()
}

export async function fetchChapter(index: number): Promise<ChapterContent> {
  const r = await fetch(`/api/chapter/${index}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`chapter ${r.status}`)
  return r.json()
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const r = await fetch('/api/sessions', { cache: 'no-store' })
  if (!r.ok) return []
  const data = (await r.json()) as { sessions: SessionInfo[] }
  return data.sessions
}

export async function fetchSessionMessages(
  id: string,
): Promise<{ mode: ModeId; title: string; messages: unknown[] }> {
  const r = await fetch(`/api/sessions/${id}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`session ${r.status}`)
  return r.json()
}

export interface RouteResult {
  decision: RouteDecision | null
  /** 命中层：rules=正则 / local=本地分类器 / llm=LLM 兜底 / llm-cache=兜底缓存 */
  used?: 'rules' | 'local' | 'llm' | 'llm-cache'
}

/** ask_ai 超时「继续/放弃」用户选择（对话框点选 → server askAiBus 消费 → 工具恢复） */
export async function submitAskAiAnswer(answer: 'continue' | 'abort'): Promise<boolean> {
  try {
    const r = await fetch('/api/browser/ask-ai-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    })
    if (!r.ok) return false
    const d = (await r.json()) as { ok: boolean }
    return d.ok === true
  } catch {
    return false
  }
}

export async function classifyRoute(text: string, current: ModeId): Promise<RouteResult | null> {
  // 客户端 6s 兜底（服务端 L2 预算 5s + 余量）：服务端无响应时不能让桌宠 preparing 无限挂起
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 6000)
  try {
    const r = await fetch('/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, current }),
      signal: ac.signal,
    })
    if (!r.ok) return null
    return (await r.json()) as RouteResult
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}


/** WS 订阅（自动重连）；onStatus 回调连接状态（供状态栏显示，可选） */
export function connectWs(onEvent: (event: WsEvent) => void, onStatus?: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0

  const connect = () => {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => onStatus?.(true)
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as WsEvent)
      } catch {
        // 忽略无法解析的消息
      }
    }
    ws.onclose = () => {
      if (closed) return
      onStatus?.(false)
      retry = Math.min(retry + 1, 6)
      setTimeout(connect, 500 * retry)
    }
    ws.onerror = () => ws?.close()
  }
  connect()

  return () => {
    closed = true
    ws?.close()
  }
}

export function newSessionId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/* ---------- M2：工作台 API ---------- */

export async function fetchDocs(): Promise<DocSection[]> {
  const r = await fetch('/api/docs', { cache: 'no-store' })
  if (!r.ok) throw new Error(`docs ${r.status}`)
  const data = (await r.json()) as { sections: DocSection[] }
  return data.sections
}

export async function fetchDoc(path: string): Promise<string> {
  const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`doc ${r.status}`)
  const data = (await r.json()) as { markdown: string }
  return data.markdown
}

export async function saveDoc(path: string, markdown: string): Promise<void> {
  const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `doc save ${r.status}`)
}

/* ---------- 人物头像（人物关系网）：设定/头像/{名字}.{ext} ---------- */

/** 头像读取 URL（t=版本号作缓存穿透；404=未上传，由调用方 onError 回退首字头像） */
export function avatarUrl(name: string, t = 0): string {
  return `/api/avatar?name=${encodeURIComponent(name)}${t ? `&t=${t}` : ''}`
}

/** 上传头像：File → base64 dataUrl → POST /api/avatar（服务端校验 png/jpeg/webp/gif ≤5MB） */
export async function uploadAvatar(name: string, file: File): Promise<{ ok: boolean; error?: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取图片失败'))
    r.readAsDataURL(file)
  })
  const r = await fetch('/api/avatar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dataUrl }),
  })
  if (!r.ok) {
    let error = `上传失败（${r.status}）`
    try {
      error = ((await r.json()) as { error?: string }).error ?? error
    } catch {
      /* 保留默认文案 */
    }
    return { ok: false, error }
  }
  return { ok: true }
}

/** 工作区图片二进制 URL（/api/raw，仅图片扩展 ≤20MB）：<img src> 直用 */
export function rawFileUrl(path: string): string {
  return `/api/raw?path=${encodeURIComponent(path)}`
}

/** 是否为可预览的图片文件（资源管理器点击分流用） */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(path)
}

export interface SaveChapterResult {
  ok: boolean
  mtime: number
  /** 保存后是否处于「作者已确认」免检状态（authorApproved=true 标记成功后 true） */
  approved?: boolean
  gate: { passed: boolean; report: GateReport }
}

export async function saveChapter(
  index: number,
  markdown: string,
  expectedMtime?: number,
  authorApproved?: boolean,
): Promise<SaveChapterResult> {
  const r = await fetch(`/api/chapter/${index}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, expectedMtime, authorApproved }),
  })
  if (r.status === 409) {
    const data = (await r.json()) as { error: string; currentMtime: number }
    throw new Error(data.error)
  }
  if (!r.ok) throw new Error(`chapter save ${r.status}`)
  return r.json()
}

export async function fetchTracking(): Promise<TrackingPanelData | null> {
  const r = await fetch('/api/tracking', { cache: 'no-store' })
  if (!r.ok) throw new Error(`tracking ${r.status}`)
  const data = (await r.json()) as { tracking: TrackingPanelData | null }
  return data.tracking
}

export async function fetchHistory(file: string): Promise<SnapshotInfo[]> {
  const r = await fetch(`/api/history?path=${encodeURIComponent(file)}`, { cache: 'no-store' })
  if (!r.ok) return []
  const data = (await r.json()) as { snapshots: SnapshotInfo[] }
  return data.snapshots
}

export async function rollbackSnapshot(file: string, snapshot: string): Promise<void> {
  const r = await fetch('/api/history/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file, snapshot }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `rollback ${r.status}`)
}

export function ttsUrl(text: string, voice: string, rate: string, pitch: string): string {
  return (
    `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}` +
    `&rate=${encodeURIComponent(rate)}&pitch=${encodeURIComponent(pitch)}`
  )
}

/* ---------- 同人衍生模式：原著原文上传 / 进度 ---------- */

/** 上传结果 */
export interface FanficSourceResult {
  ok: boolean
  /** true = 覆盖了未拆书的旧文件 */
  overwrite: boolean
  path: string
  bytes: number
  volumeNo: number
  label: string
  chars: number
}

/** 上传原著原文（前端完成 UTF-8/GBK 编码检测转码后提交纯文本） */
export async function uploadFanficSource(
  content: string,
  opts: { filename?: string; volumeNo?: number; volumeLabel?: string } = {},
): Promise<FanficSourceResult> {
  const r = await fetch('/api/fanfic/source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...opts }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/source ${r.status}`)
  return r.json()
}

/** 同人整体进度（_progress.json v2 + 磁盘派生真值；失败返回 null 由面板显示空态） */
export async function fetchFanficProgress(): Promise<FanficProgress | null> {
  try {
    const r = await fetch('/api/fanfic/progress', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as FanficProgress
  } catch {
    return null
  }
}

/** 第 1 步设定文件分组（原著设定 / 专属设定） */
export async function fetchFanficFiles(): Promise<FanficFileGroup[]> {
  try {
    const r = await fetch('/api/fanfic/files', { cache: 'no-store' })
    if (!r.ok) return []
    const data = (await r.json()) as { groups: FanficFileGroup[] }
    return data.groups ?? []
  } catch {
    return []
  }
}

/** 单卷拆书详情（摘要 + 聚合产物全文）；失败返回 null */
export async function fetchFanficVolume(id: number): Promise<FanficVolumeDetail | null> {
  try {
    const r = await fetch(`/api/fanfic/volume?id=${id}`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as FanficVolumeDetail
  } catch {
    return null
  }
}

/** 面板确认拆书卷（volumes[].status=confirmed）；missing = 缺失聚合产物的卷 → 提示 agent 补齐 */
export async function fanficConfirmVolumes(volumes: number[]): Promise<{ ok: boolean; missing: Record<string, string[]> }> {
  const r = await fetch('/api/fanfic/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volumes }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/confirm ${r.status}`)
  return r.json()
}

/** 新建本书卷（拆书页「新建卷纲」弹窗：对应原著卷可多选 + 卷名 + 预计章节数）；确认后自动进入第 3 步 */
export async function fanficVolumeCreate(
  name: string,
  chapters: number,
  sourceVolumes: number[],
): Promise<FanficFicVolume> {
  const r = await fetch('/api/fanfic/volume-create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, chapters, sourceVolumes }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/volume-create ${r.status}`)
  const data = (await r.json()) as { ok: boolean; volume: FanficFicVolume }
  return data.volume
}

/** 细纲逐章确认（绿色已完善）；confirmed=false = 取消确认 */
export async function fanficChaptersConfirm(
  volume: number,
  chapters: number[],
  confirmed = true,
): Promise<{ ok: boolean; confirmedChapters: number[] }> {
  const r = await fetch('/api/fanfic/chapters-confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume, chapters, confirmed }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/chapters-confirm ${r.status}`)
  return r.json()
}

/** 面板推进步骤（2 拆书 / 3 卷纲细纲 / 4 创作；服务端带前置守卫） */
export async function fanficAdvance(to: number): Promise<void> {
  const r = await fetch('/api/fanfic/advance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/advance ${r.status}`)
}

/** 同人分岔点标记（写入 _progress.json 该卷 forkEvent；event 空 = 清除标记） */
export async function fanficSetFork(volume: number, event: string): Promise<void> {
  const r = await fetch('/api/fanfic/fork', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume, event }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `fanfic/fork ${r.status}`)
}

/* ---------- M3：导入 / 通用文件 / 报告 ---------- */

export async function saveInboxDraft(markdown: string, title: string): Promise<{ ok: boolean; path: string; bytes: number }> {
  const r = await fetch('/api/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, title }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `inbox ${r.status}`)
  return r.json()
}

export interface InboxDraft {
  name: string
  path: string
  mtime: number
  bytes: number
}

/** 导入草稿队列（inbox 历史草稿，mtime 倒序） */
export async function fetchInboxDrafts(): Promise<InboxDraft[]> {
  try {
    const r = await fetch('/api/inbox', { cache: 'no-store' })
    if (!r.ok) return []
    const data = (await r.json()) as { drafts: InboxDraft[] }
    return data.drafts ?? []
  } catch {
    return []
  }
}

/** 通用文件读取（审批 diff 预览 / 报告正文）。文件不存在返回 null（新文件无 diff） */
export async function fetchWorkspaceFile(path: string): Promise<string | null> {
  return (await fetchWorkspaceFileMeta(path)).content
}

/** 通用文件读取（含文章「作者已确认」免检状态） */
export async function fetchWorkspaceFileMeta(path: string): Promise<{ content: string | null; approved: boolean }> {
  try {
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
    if (!r.ok) return { content: null, approved: false }
    const data = (await r.json()) as { content: string; approved?: boolean }
    return { content: data.content, approved: data.approved === true }
  } catch {
    return { content: null, approved: false }
  }
}

/** 通用文件写入（资源管理器打开的文档保存：工作区沙箱内任意文本文件；追踪/ 派生视图服务端拒绝）。
 *  authorApproved=true=作者手工标记「此版负责」→ 正文文件登记免检。 */
export async function saveFile(path: string, content: string, opts?: { authorApproved?: boolean }): Promise<void> {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, authorApproved: opts?.authorApproved === true }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `file save ${r.status}`)
}

export interface ReportBrief {
  name: string
  path: string
  mtime: number
  bytes: number
}

export async function fetchReports(): Promise<ReportBrief[]> {
  const r = await fetch('/api/reports', { cache: 'no-store' })
  if (!r.ok) return []
  const data = (await r.json()) as { reports: ReportBrief[] }
  return data.reports
}

/* ---------- M4：书架（多书管理） ---------- */

export interface BookBrief {
  dir: string
  name: string
  title: string
  current: boolean
}

export async function fetchBooks(): Promise<{ parent: string; books: BookBrief[] }> {
  const r = await fetch('/api/books', { cache: 'no-store' })
  if (!r.ok) return { parent: '', books: [] }
  return r.json()
}

export async function switchBook(dir: string): Promise<{ ok: boolean; bookTitle: string; switched: boolean }> {
  const r = await fetch('/api/books/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `switch ${r.status}`)
  return r.json()
}

/** M5：绝对路径工作区切换（欢迎页 / 自定义目录） */
export async function switchWorkspace(path: string): Promise<{ ok: boolean; bookTitle: string; switched: boolean }> {
  const r = await fetch('/api/workspace/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `switch workspace ${r.status}`)
  return r.json()
}

/* ---------- M6：空间目录（欢迎页：新建/打开/最近记录） ---------- */

export interface SpaceBook {
  path: string
  title: string
  openedAt: string
}

export interface SpaceRoot {
  label: string
  path: string
}

export async function fetchSpaces(): Promise<{ spaceDir: string; books: SpaceBook[] }> {
  const r = await fetch('/api/spaces', { cache: 'no-store' })
  if (!r.ok) return { spaceDir: '', books: [] }
  return r.json()
}

export async function fetchSpaceRoots(): Promise<{ roots: SpaceRoot[] }> {
  const r = await fetch('/api/spaces/roots', { cache: 'no-store' })
  if (!r.ok) return { roots: [] }
  return r.json()
}

export async function fetchSpaceTree(root: string): Promise<{ root: string; dirs: string[]; files: string[] }> {
  const r = await fetch(`/api/spaces/tree?root=${encodeURIComponent(root)}`, { cache: 'no-store' })
  if (!r.ok) return { root, dirs: [], files: [] }
  return r.json()
}

/** 资源管理器右键：在系统文件管理器中定位该文件（Windows explorer /select） */
export async function revealInExplorer(path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/fs/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  return r.json()
}

/** 资源管理器右键：删除工作区内文件/目录（服务端二次校验边界；前端已弹确认） */
export async function deleteWorkspaceFile(path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/fs/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  return r.json()
}

export async function openSpaceBook(
  path: string,
): Promise<{ ok: boolean; bookTitle: string; switched: boolean; books: SpaceBook[] }> {
  const r = await fetch('/api/spaces/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `open space book ${r.status}`)
  return r.json()
}

export async function createSpaceBook(
  parentPath: string,
  title: string,
): Promise<{ ok: boolean; dir: string; bookTitle: string; switched: boolean; books: SpaceBook[] }> {
  const r = await fetch('/api/spaces/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentPath, title }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `create space book ${r.status}`)
  return r.json()
}

// ── 音乐源（右下角播放器；解析代理走 /api/music/*，源为用户自部署的兼容 API）──

export type MusicPlatform = 'netease' | 'qq' | 'custom'

export interface MusicSettingsInfo {
  configured: boolean
  platform: MusicPlatform
  apiBase: string
  loggedIn: boolean
}

export async function fetchMusicSettings(): Promise<MusicSettingsInfo> {
  const r = await fetch('/api/music/settings', { cache: 'no-store' })
  if (!r.ok) throw new Error(`music settings ${r.status}`)
  return r.json()
}

export async function saveMusicSettings(
  platform: MusicPlatform,
  apiBase: string,
  cookie?: string,
): Promise<MusicSettingsInfo> {
  const r = await fetch('/api/music/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, apiBase, ...(cookie !== undefined ? { cookie } : {}) }),
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `save music settings ${r.status}`)
  return r.json()
}

export interface MusicSearchSong {
  id: string
  name: string
  artist: string
}

export async function musicSearch(keywords: string): Promise<MusicSearchSong[]> {
  const r = await fetch(`/api/music/search?keywords=${encodeURIComponent(keywords)}`, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json()).error ?? `search ${r.status}`)
  const d = (await r.json()) as { songs: MusicSearchSong[] }
  return d.songs
}

/** 解析播放直链（VIP 无会员 / 版权限制时服务端 404，message 已说明原因） */
export async function musicSongUrl(id: string): Promise<string> {
  const r = await fetch(`/api/music/song-url?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json()).error ?? `song url ${r.status}`)
  const d = (await r.json()) as { url: string }
  return d.url
}

/** 歌词（LRC 原文 + 可选中文翻译；无歌词/平台不支持时两个空串） */
export async function musicLyric(id: string): Promise<{ lyric: string; tlyric: string }> {
  const r = await fetch(`/api/music/lyric?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json()).error ?? `lyric ${r.status}`)
  return r.json()
}

// ── 动态背景（设置中心 · 外观；视频存服务端 .local/background.mp4）──

export interface BackgroundInfo {
  enabled: boolean
  /** 已上传文件大小（字节；未设置时 0） */
  size: number
}

export async function fetchBackground(): Promise<BackgroundInfo> {
  const r = await fetch('/api/background', { cache: 'no-store' })
  if (!r.ok) return { enabled: false, size: 0 }
  return r.json()
}

/** 上传 MP4（二进制 body，≤30M）；返回最新的背景状态 */
export async function uploadBackground(file: File): Promise<BackgroundInfo> {
  const r = await fetch('/api/background', {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body: file,
  })
  if (!r.ok) throw new Error((await r.json()).error ?? `upload ${r.status}`)
  return r.json()
}

export async function clearBackground(): Promise<BackgroundInfo> {
  const r = await fetch('/api/background', { method: 'DELETE' })
  if (!r.ok) throw new Error((await r.json()).error ?? `clear ${r.status}`)
  return r.json()
}

/** 扫码登录第一步：拿 key + 二维码 dataURL */
export async function musicQrStart(): Promise<{ key: string; qrimg: string }> {
  const r = await fetch('/api/music/qr/start', { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json()).error ?? `qr start ${r.status}`)
  return r.json()
}

/** 扫码状态轮询：801=待扫码 802=已扫待确认 803=登录成功 800=过期 */
export async function musicQrCheck(key: string): Promise<{ code: number; message: string }> {
  const r = await fetch(`/api/music/qr/check?key=${encodeURIComponent(key)}`, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json()).error ?? `qr check ${r.status}`)
  return r.json()
}

/** 个人化默认歌单：我喜欢的 + 最近在听（未登录时两个列表为空、loggedIn=false） */
export interface MusicPersonal {
  loggedIn: boolean
  liked: MusicSearchSong[]
  recent: MusicSearchSong[]
}

export async function musicPersonal(): Promise<MusicPersonal> {
  const r = await fetch('/api/music/personal', { cache: 'no-store' })
  if (!r.ok) throw new Error(`music personal ${r.status}`)
  return r.json()
}
