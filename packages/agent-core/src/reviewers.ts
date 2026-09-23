/**
 * 多视角并行审稿（story-review full 模式）：为每个视角 spawn 一个独立只读子 Agent。
 * 子 Agent 工具 = 只读文件 + Bash（跑预检脚本）+ load_skill/query_tracking；
 * 各自独立工具循环（stopWhen 30 步），互不共享上下文，Promise.all 并行。
 */
import { createDeepSeek } from '@ai-sdk/deepseek'
import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import type { ReviewerRequest, ReviewerResult } from '@story-studio/tools'
import type { AgentModelConfig } from './agent.ts'
import { chatLog } from './log.ts'
import { normalizingFetch } from './normalizeStream.ts'
import { opencodeGatewayHeaders } from './gateway.ts'

/** 子 Agent 可用的工具（只读审查，无写入通道） */
const REVIEWER_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'ListFiles',
  'Bash',
  'load_skill',
  'query_tracking',
  'web_search',
]

export interface ReviewerSpawnerDeps {
  model: AgentModelConfig
  /** 全量工具集（过滤出子集） */
  tools: ToolSet
}

const BASE_INSTRUCTIONS = `你是 Story Studio 的审稿子 Agent，只负责一个审查视角。铁律：只读——不写不删任何文件，只产出审查报告文本。
工作区文件可直接用 Read/Grep/Glob 读取；可用 Bash 跑质检脚本（node scripts/check-ai-patterns.js --check --fail-on=blocking <文件> 等）；可 load_skill 加载 story-review 技能获取完整审查标准。
输出要求：以 Findings 列表为主体，每条含 severity（S1 致命/S2 严重/S3 一般/S4 建议）、location（章节+可定位引文片段）、evidence（原文摘录）、issue（问题说明）、fix（修改建议）。最后给本视角总体评价（2-3 句）。`

export function createReviewerSpawner(deps: ReviewerSpawnerDeps) {
  return async (req: ReviewerRequest): Promise<ReviewerResult[]> => {
    const provider = createDeepSeek({
      baseURL: deps.model.baseUrl,
      apiKey: deps.model.apiKey,
      fetch: normalizingFetch,
      // 每批审稿创建一次 provider → 缺省随机会话 id 恰好整批稳定（并行视角共享，提示词缓存友好）
      headers: opencodeGatewayHeaders(deps.model.baseUrl),
    })
    const model = provider.chat(deps.model.modelId)
    const subTools: ToolSet = Object.fromEntries(
      Object.entries(deps.tools).filter(([name]) => REVIEWER_TOOLS.includes(name)),
    )
    // 整批审稿（各视角 + 各步）的 token 累计，结束时逐视角汇总落日志
    const usage = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    return Promise.all(
      req.perspectives.map(async (perspective) => {
        const agent = new ToolLoopAgent({
          model,
          instructions: `${BASE_INSTRUCTIONS}\n\n【你的审查视角】${perspective}。只从这个视角审查，其他视角的问题交给别的子 Agent。`,
          tools: subTools,
          stopWhen: stepCountIs(30),
          onStepEnd: (event) => {
            usage.calls += 1
            usage.inputTokens += event.usage?.inputTokens ?? 0
            usage.outputTokens += event.usage?.outputTokens ?? 0
            const d = event.usage?.inputTokenDetails
            usage.noCacheTokens += d?.noCacheTokens ?? 0
            usage.cacheReadTokens += d?.cacheReadTokens ?? 0
            usage.cacheWriteTokens += d?.cacheWriteTokens ?? 0
          },
        })
        try {
          const result = await agent.generate({
            messages: [{ role: 'user', content: req.instruction }],
          })
          const text =
            typeof result.text === 'string' && result.text.trim()
              ? result.text
              : JSON.stringify(result.content ?? result).slice(0, 20_000)
          return { perspective, report: text }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { perspective, report: `（本视角审查失败：${msg}）` }
        }
      }),
    ).then((results) => {
      if (usage.calls > 0) {
        chatLog(
          'info',
          `[review_agents] token 消耗（${req.perspectives.length} 视角并行）：模型调用 ${usage.calls} 次 | 输入 ${usage.inputTokens}（缓存命中 ${usage.cacheReadTokens} / 未缓存 ${usage.noCacheTokens} / 写缓存 ${usage.cacheWriteTokens}）| 输出 ${usage.outputTokens}`,
        )
      }
      return results
    })
  }
}
