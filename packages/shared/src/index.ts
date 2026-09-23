/** 前后端共享类型（packages/shared） */

export type ModeId =
  | 'discuss'
  | 'write'
  | 'import'
  | 'polish'
  | 'preview'
  | 'market'
  | 'review'
  | 'fanfic'
  | 'calibrate'

export interface ModeMeta {
  id: ModeId
  label: string
  /** 前端图标名（assets/icons/<icon>.svg） */
  icon: string
  desc: string
}

export const MODES: ModeMeta[] = [
  { id: 'discuss', label: '讨论', icon: 'brain', desc: '新书讨论、剧情大纲探讨、设定优化' },
  { id: 'write', label: '创作', icon: 'pen-line', desc: '短/中/长/超长篇正文创作（单章 13 步流程）' },
  { id: 'import', label: '导入', icon: 'inbox', desc: '外部章节导入适配：格式化+质检+追踪补录' },
  { id: 'polish', label: '优化', icon: 'spark', desc: '去 AI 味 / 文笔优化 / 大修' },
  { id: 'review', label: '审稿', icon: 'book-open', desc: '多视角审稿，S1-S4 分级报告' },
  { id: 'market', label: '市场', icon: 'chart-bar', desc: '扫榜 / 拆文' },
  { id: 'preview', label: '预览', icon: 'eye-scan', desc: '阅读 / 听书 / 资料库（纯前端，不消耗 Agent）' },
  { id: 'fanfic', label: '同人', icon: 'dna', desc: '同人衍生：原著设定 → 拆书 → 专属设定 → 细纲 → 创作' },
  { id: 'calibrate', label: '校准', icon: 'target', desc: '一致性校准：跨文件矛盾诊断与滞后内容修复' },
]

export function modeMeta(id: ModeId): ModeMeta {
  return MODES.find((m) => m.id === id) ?? MODES[0]
}

/** 门禁脚本执行结果 */
export interface GateScriptResult {
  name: string
  exitCode: number
  output: string
}

export interface GateReport {
  chapter: number | null
  file: string
  passed: boolean
  attempts: number
  stopped: boolean
  scripts: GateScriptResult[]
}

/** 同人模式：定向搜索站点（设置中心「同人」页可增删） */
export interface FanficSearchSite {
  id: string
  name: string
  host: string
}

/** 同人模式默认搜索源（联网检索原著设定时先自由搜索、再按清单 site: 定向补全） */
export const DEFAULT_FANFIC_SEARCH_SITES: FanficSearchSite[] = [
  { id: 'moegirl', name: '萌娘百科', host: 'zh.moegirl.org.cn' },
  { id: 'baike', name: '百度百科', host: 'baike.baidu.com' },
  { id: 'wiki', name: '维基百科', host: 'wikipedia.org' },
  { id: 'tieba', name: '百度贴吧', host: 'tieba.baidu.com' },
  { id: 'bilibili', name: 'Bilibili', host: 'bilibili.com' },
  { id: 'qidian', name: '起点中文网', host: 'qidian.com' },
]

/** 同人模式：单卷拆书进度（summarized 由服务端从摘要文件存在性派生） */
export interface FanficVolumeProgress {
  id: number
  label: string
  source: string
  chapters: number
  summarized: number
  status: string
  /** 同人分岔点：用户在面板卷详情「时间线」（原著时间线）上点选的事件文本；空 = 未选 */
  forkEvent: string
}

/** 同人模式四步标签（与 story-fanfic SKILL.md 四步制一致） */
export const FANFIC_STEPS = ['设定', '拆书', '卷纲与细纲', '创作'] as const

/** 同人模式：本书卷（同人的分卷，可对应多原著拆书卷；细纲按章确认） */
export interface FanficFicVolume {
  /** 本书卷号（1 起） */
  id: number
  /** 本书卷名（如「第一卷」） */
  name: string
  /** 本书卷预计章节数（用户登记） */
  chapters: number
  /** 本书卷时间线对应的原著拆书卷号（可多选） */
  sourceVolumes: number[]
  /** 卷目录（大纲/第{id}卷_{卷名}）：本卷的 卷纲.md 与 细纲_第NNN章.md 都放这里 */
  dir: string
  /** 已确认完善的细纲章号（面板逐章勾选确认，绿色态；确认后进入创作页） */
  confirmedChapters: number[]
}

/** 同人模式整体进度（GET /api/fanfic/progress 返回体；源自 原著/_progress.json v2 + 磁盘派生真值）。
 *  四步制：1 设定（原著+专属，substep 标识当前在哪个子步）2 拆书 3 卷纲与细纲（ficVolumes=本书卷）4 创作 */
export interface FanficProgress {
  exists: boolean
  /** 1-4 四步制当前步；不存在时 0 */
  step: number
  /** 步内子阶段：s1 = source（原著设定）/ own（专属设定）；s3 = juan（卷纲）/ xi（细纲）；其余步空串 */
  stepSub: string
  meta: { title: string; author: string; totalChars: number; updatedAt: string } | null
  volumes: FanficVolumeProgress[]
  /** 本书卷清单（第 3 步按卷组织：卷列表 → 卷详情（时间线对照/卷纲/细纲确认）→ 第 4 步创作） */
  ficVolumes: FanficFicVolume[]
  compareFiles: string[]
  sourceFiles: Array<{ name: string; path: string; bytes: number; mtime: number }>
  /** 待确认设定草稿（原著/草稿/*.md，agent 检索总结后先落草稿、用户在面板确认后转正） */
  draftFiles: Array<{ name: string; path: string; bytes: number; mtime: number }>
}

/** 同人模式设定/大纲文件分组（GET /api/fanfic/files：面板第 1/3 步浏览器数据源） */
export interface FanficFileGroup {
  key: 'source' | 'own' | 'outline'
  label: string
  desc: string
  files: Array<{ name: string; path: string; bytes: number; mtime: number }>
}

/** 同人模式单卷拆书详情（GET /api/fanfic/volume：面板第 2 步点开卷查看） */
export interface FanficVolumeDetail {
  volume: FanficVolumeProgress
  /** 桥段摘要文件（按文件名排序，content 为全文） */
  summaries: Array<{ name: string; path: string; content: string }>
  /** 聚合产物全文（null = 尚未生成） */
  artifacts: { timeline: string | null; characters: string | null; summary: string | null }
}


/** 常见模型上下文容量（token）；未收录模型给保守默认 128k（agent-core 与前端共用） */
const MODEL_CONTEXT: Array<[RegExp, number]> = [
  [/deepseek-v4/i, 1_000_000],
  [/deepseek-(chat|reasoner)/i, 131_072],
  [/glm-5/i, 204_800],
  [/kimi|k2/i, 256_000],
  [/qwen3?-max/i, 1_000_000],
  [/qwen/i, 131_072],
]

export function modelContextTokens(modelId: string): number {
  for (const [re, n] of MODEL_CONTEXT) if (re.test(modelId)) return n
  return 131_072
}

export type WsEvent =
  | { type: 'file:changed'; path: string; kind: 'chapter' | 'outline' | 'setting' | 'tracking' | 'report' | 'source' }
  | { type: 'gate:result'; report: GateReport }
  | { type: 'agent:status'; phase: 'idle' | 'thinking' | 'tool' | 'stopped' }
  | { type: 'agent:step'; step: number; total: number }
  | {
      type: 'agent:usage'
      /** 所属会话：会话切换后，旧会话仍在跑的流不应再驱动当前进度条 */
      sessionId: string
      /** 本轮（chatStream 生命周期）累计：逐步模型调用求和 */
      calls: number
      inputTokens: number
      outputTokens: number
      noCacheTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      /** 最近一次模型调用的输入 ≈ 当前上下文占用（容量进度条数据源） */
      lastInputTokens: number
      /** 上下文构成估算（token 估算值，占比展示用）：系统提示/技能目录/工具定义/历史消息/其他 */
      breakdown: { system: number; skills: number; tools: number; messages: number; other: number }
      /** 模型上下文容量（按模型 id 查表，未知模型给保守默认） */
      capacity: { model: string; tokens: number }
      /** 本轮总耗时 ms（仅最终快照 >0） */
      durationMs: number
    }
  | { type: 'tracking:updated'; revision: number }
  | { type: 'mode:switched'; mode: ModeId; reason?: string }
  | { type: 'book:switched'; workspace: string; bookTitle: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string; at: string }
  | { type: 'browser:login-required'; message: string }
  | { type: 'browser:login-resolved' }
  | { type: 'browser:agent-control'; active: boolean }
  /** ask_ai 网页 AI 生成超时：等待用户在页面上选择「继续等待 / 放弃」（配对 browser:ask-ai-answered） */
  | { type: 'browser:ask-ai-waiting'; sessionId?: string; site?: string; waitedSec?: number }

export interface ChapterBrief {
  index: number
  file: string
  title: string
  bytes: number
}

export interface BookInfo {
  title: string
  workspace: string
  chapters: ChapterBrief[]
  latestChapter: number
  trackingRevision: number | null
  lastCommittedChapter: number | null
  outlineFiles: string[]
  settingFiles: string[]
  trackingFiles: string[]
}

export interface ChapterContent {
  index: number
  file: string
  title: string
  markdown: string
  /** 磁盘 mtime（epoch ms），编辑器保存时做冲突检测 */
  mtime: number
}

export interface DocCard {
  path: string
  name: string
  kind: 'md' | 'json'
  title: string
  /** true = 只读展示（追踪派生视图由 tracking 工具管理） */
  readOnly?: boolean
  /** 文件大小（字节；资料卡 meta 展示用） */
  bytes?: number
  /** 磁盘 mtime（epoch ms；资料卡「x 天前」相对时间展示用） */
  mtime?: number
}

export interface DocGroup {
  group: string
  cards: DocCard[]
}

export interface DocSection {
  key: string
  exists: boolean
  groups: DocGroup[]
  readOnly?: boolean
}

export interface TrackingCharacter {
  name: string
  identity: string
  location: string
  goal: string
  state: string
  abilities: string[]
  knowledge: string[]
  openThreads: string[]
  relationships: string[]
  updatedChapter: number | null
}

export interface TrackingForeshadow {
  id: string
  summary: string
  plantedChapter: number | null
  plannedResolution: number | null
  status: string
  importance: string
}

export interface TrackingEvent {
  id: string
  storyTime: string
  objectiveFact: string
  readerKnowledge: string
  revealStatus: string
  revealChapter: number | null
  characters: string[]
}

export interface TrackingPanelData {
  bookTitle: string
  revision: number | null
  lastCommittedChapter: number | null
  importedThroughChapter: number | null
  characters: TrackingCharacter[]
  foreshadows: TrackingForeshadow[]
  timeline: TrackingEvent[]
  chapterRecords: string[]
  context: {
    volume: string
    storyTime: string
    scene: string
    longTermConstraints: string[]
    activeCharacterNames: string[]
    continuityRisks: string[]
    nextChapterCommitments: string[]
  }
}

export interface SnapshotInfo {
  file: string
  snapshot: string
  mtime: number
  bytes: number
}

export interface SessionInfo {
  id: string
  title: string
  mode: ModeId
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SkillSummary {
  name: string
  description: string
}

export interface ServerConfig {
  bookTitle: string
  workspace: string
  modelId: string
  baseUrl: string
  hasApiKey: boolean
  skills: SkillSummary[]
  modes: ModeMeta[]
  /** 可选模型（输入栏切换）= 用户在设置面板配置的全部 Provider；id 即 providerId */
  models: Array<{ id: string; label: string; modelId: string; supportsImages?: boolean; free?: boolean }>
  /** 激活 Provider 的 id（输入栏未手动切换时的默认模型；.env 兜底时为空） */
  activeModelId?: string
  /** 思考强度候选（展示用） */
  reasoningEfforts: Array<{ id: string; label: string }>
}

export const GATE_SCRIPTS = [
  'normalize-punctuation.js',
  'check-ai-patterns.js',
  'check-outline-copy.js',
  'check-degeneration.js',
] as const
