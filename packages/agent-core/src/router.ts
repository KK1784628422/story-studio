/**
 * 模式路由器（双通道的手动通道由 UI 完成；此处为自动通道）：
 * 两级——本地正则规则优先（毫秒级）；规则未命中时 LLM 兜底分类（任意措辞全覆盖），
 * 兜底失败/超时保持当前模式。
 */
import type { ModeId } from '@story-studio/shared'
import { chatLog } from './log.ts'

export interface RouteDecision {
  mode: ModeId
  reason: string
}

interface Rule {
  re: RegExp
  mode: ModeId
  reason: string
}

/** 顺序即优先级：大修/去味（含"重写第X章"）先于"写第N章"，避免误路由 */
const RULES: Rule[] = [
  { re: /去\s*AI\s*味|文笔优化|润色|优化这[一]?[章篇]|大修|回炉|重写第\s*\d+\s*章/, mode: 'polish', reason: '检测到优化/大修意图' },
  // 同人衍生意图：置于 write 之前，防「写同人/同人开书」被 write 规则抢走
  { re: /同人|衍生|原著(设定|拆书|拆解|时间线)|fanfic/i, mode: 'fanfic', reason: '检测到同人衍生意图' },
  { re: /写第\s*\d+\s*章|日更|续写|继续写|开书|写个?短篇|写大纲|出细纲|补纲|扩纲|更文|码[一两三几\d]{0,2}章|更新.{0,4}章/, mode: 'write', reason: '检测到创作指令' },
  // 人物头像/生图指令：确定性路由到有 webai_draw 的模式（write/discuss 均带生图能力），不依赖 LLM 兜底。
  // ⚠ 实测（2026-09-02 a7482c08）：无此规则 + LLM 兜底超时 → 生图请求滞留 preview 只读模式，
  //   模型连撞 4 次 AI_NoSuchToolError（webai_draw×2 + Write×2）才靠 switch_mode 自救，浪费 3 步。
  { re: /头像|立绘|角色图|生图|豆包/, mode: 'write', reason: '检测到人物头像/生图指令' },
  { re: /导入|这是我在别处写的|我(在别处|用其他?AI).{0,8}(写|弄)|粘贴(进来|一段)/, mode: 'import', reason: '检测到外部章节导入' },
  { re: /审(查|稿)|看看.{0,8}有没有问题|检查第\s*\d+/, mode: 'review', reason: '检测到审稿意图' },
  // 校准意图：一致性诊断/滞后同步（「重构大纲」在用户语境=校准对齐而非重写；write 规则的 写大纲/补纲/扩纲 与本规则无重叠）
  { re: /校准|一致性(检查|诊断|核对|校准)|同步(设定|大纲|细纲|文件)|大纲?滞后|矛盾排查|重构大纲/, mode: 'calibrate', reason: '检测到一致性校准意图' },
  { re: /什么火|比较火|很火|热门|爆款|排行|榜单|扫榜|拆(一|这)本|市场(调研|分析)|行情|趋势/, mode: 'market', reason: '检测到市场调研意图' },
  { re: /(^|[^写改])预览|读一下|听(书|一下)/, mode: 'preview', reason: '检测到预览/听书意图' },
]

export function classifyIntent(text: string, current: ModeId): RouteDecision | null {
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      if (rule.mode === current) return null // 已在目标模式
      return { mode: rule.mode, reason: `${rule.reason}：「${text.slice(0, 24)}」` }
    }
  }
  return null
}

// ---- LLM 意图分类兜底（规则未命中时调用，任意措辞全覆盖）----

import { generateText } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { normalizingFetch } from './normalizeStream.ts'
import { opencodeGatewayHeaders } from './gateway.ts'

export interface RouterModel {
  baseUrl: string
  apiKey: string
  modelId: string
}

const VALID_MODES = ['discuss', 'write', 'import', 'polish', 'preview', 'market', 'review', 'fanfic', 'calibrate'] as const

const MODE_OPTIONS = [
  'discuss：新书讨论 / 剧情 / 大纲探讨 / 设定优化（写设定大纲前需用户确认）',
  'write：写正文 / 日更 / 续写 / 开书写细纲',
  'import：把用户从别处写的章节导入适配进工作区',
  'polish：去 AI 味 / 文笔优化 / 大修 / 重写',
  'preview：只想预览阅读 / 听书 / 查资料（只读，不动 Agent 也可满足）',
  'market：市场调研 / 扫榜 / 看什么火 / 拆书 / 趋势行情',
  'review：审稿 / 检查章节有没有问题',
  'fanfic：同人衍生创作（统计原著设定 / 拆原著书 / 专属设定 / 大纲细纲 / 同人正文）',
  'calibrate：一致性校准 / 跨文件矛盾诊断 / 同步滞后的大纲设定 / 重构大纲对齐',
].join('\n')

/**
 * 规则未命中时的 LLM 兜底：极短分类调用（最低思考档、限长、限时），
 * 输出 {mode, reason}；任何失败（超时/非法输出/网络）都返回 null → 保持当前模式。
 * 同句 LRU 缓存（64 条 / 24h，含 null 结果）：重复语句 0ms 且不再重复付模型。
 */
const LRU_MAX = 64
const LRU_TTL_MS = 24 * 60 * 60 * 1000
const llmCache = new Map<string, { decision: RouteDecision | null; at: number }>()

export async function classifyWithModel(text: string, modelConf: RouterModel, timeoutMs = 5000): Promise<RouteDecision | null> {
  const key = text.trim()
  const hit = llmCache.get(key)
  if (hit && Date.now() - hit.at < LRU_TTL_MS) {
    // 刷新插入位置（Map 迭代序 = 插入序，最旧在首）
    llmCache.delete(key)
    llmCache.set(key, hit)
    return hit.decision
  }
  const decision = await classifyWithModelUncached(text, modelConf, timeoutMs)
  llmCache.set(key, { decision, at: Date.now() })
  if (llmCache.size > LRU_MAX) {
    const oldest = llmCache.keys().next().value
    if (oldest !== undefined) llmCache.delete(oldest)
  }
  return decision
}

/** LRU 缓存窥探：命中返回 decision 或 null；未命中返回 undefined（供 /api/route 区分 used:'llm-cache'） */
export function peekLlmCache(text: string): RouteDecision | null | undefined {
  const hit = llmCache.get(text.trim())
  if (!hit || Date.now() - hit.at >= LRU_TTL_MS) return undefined
  return hit.decision
}

async function classifyWithModelUncached(text: string, modelConf: RouterModel, timeoutMs: number): Promise<RouteDecision | null> {
  const provider = createDeepSeek({
    baseURL: modelConf.baseUrl,
    apiKey: modelConf.apiKey,
    fetch: normalizingFetch,
    headers: opencodeGatewayHeaders(modelConf.baseUrl),
  })
  try {
    const { text: out } = await generateText({
      model: provider.chat(modelConf.modelId),
      system:
        '你是模式意图分类器。根据用户最新一条输入判断他接下来想用哪个模式。' +
        '只输出一行 JSON（不要任何其他文字）：{"mode":"模式id","reason":"不超过20字的原因"}\n\n' +
        '可选模式：\n' + MODE_OPTIONS,
      prompt: text,
      temperature: 0,
      maxOutputTokens: 40,
      abortSignal: AbortSignal.timeout(timeoutMs),
      // 网关强制思考不可关闭（报错提示用 low/high/max），选最低档压低延迟
      providerOptions: { deepseek: { reasoningEffort: 'low' } },
    })
    const m = out.match(/\{[\s\S]*?\}/)
    if (!m) return null
    const obj = JSON.parse(m[0]) as { mode?: unknown; reason?: unknown }
    const modeId = String(obj.mode ?? '').trim()
    if (!(VALID_MODES as readonly string[]).includes(modeId)) return null
    return { mode: modeId as ModeId, reason: String(obj.reason ?? 'LLM 意图识别').slice(0, 40) }
  } catch (err) {
    // 失败（超时/网络/非法输出）→ 保持当前模式，路由不阻塞发送；原因记日志便于排查
    const name = err instanceof Error ? err.name : 'UnknownError'
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort|timeout/i.test(name)) {
      chatLog('warn', `[route] LLM 兜底分类超时（${timeoutMs}ms），保持当前模式`)
    } else {
      chatLog('warn', `[route] LLM 兜底分类失败（保持当前模式）：${name} ${msg}`)
    }
    return null
  }
}
