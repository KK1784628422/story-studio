/**
 * Agent 运行时：ToolLoopAgent 构建（AI SDK 7）+ 工具审批（needsApproval 停靠）+ 流式响应。
 * 审批机制：模式策略 → toolApproval 配置 → 工具调用暂停等待用户允许/拒绝
 *   （讨论模式 Write/Edit 全审批；导入模式改写既有文件审批；客户端 addToolApprovalResponse 续流）。
 */
import { createDeepSeek } from '@ai-sdk/deepseek'
import {
  ToolLoopAgent,
  createAgentUIStreamResponse,
  stepCountIs,
  NoSuchToolError,
  type ToolApprovalConfiguration,
  type ToolSet,
  type UIMessage,
} from 'ai'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SkillLoader } from '@story-studio/skills'
import { modelContextTokens, type ModeId } from '@story-studio/shared'
import { getMode } from './modes.ts'
import { buildSystemPrompt, type PromptStatus } from './prompt.ts'
import { chatLog } from './log.ts'
import { normalizingFetch } from './normalizeStream.ts'
import { createFailoverFetch } from './failoverFetch.ts'
import { opencodeGatewayHeaders } from './gateway.ts'

export interface AgentModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
}

export interface StoryAgentDeps {
  model: AgentModelConfig
  workspace: string
  skills: SkillLoader
  tools: ToolSet
}

export interface ChatStreamOptions {
  mode: ModeId
  /** 会话级稳定 id（opencode 网关 x-opencode-session 用；同一对话请求保持一致） */
  sessionId?: string
  /**
   * 运行中模式的实时引用（chat.ts 持有，switch_mode 工具经 toolCtx.setMode 更新）。
   * prepareStep 每步据此重算工具集/提示词，使 switch_mode 同轮即时生效。
   */
  modeRef?: { current: ModeId }
  /** 客户端发来的完整 UIMessage 历史 */
  messages: UIMessage[]
  status: PromptStatus
  preferences: string
  /** 模式专属上下文（同人模式搜索源清单）：仅 fanfic 模式拼进系统提示词 */
  modeContext?: string
  /** 会话中已存在的目录 digest（null=首次）；与当前不同则追加替换消息 */
  previousCatalogDigest: string | null
  /** DeepSeek 思考强度（low/high/max；缺省 max=最大思考） */
  reasoningEffort?: string
  /** 输出 token 上限（缺省由 provider 决定；deepseek-v4 支持 1M 上下文） */
  maxOutputTokens?: number
  /**
   * 运行时模型覆盖（来自用户手动配置的 Provider，服务端已解析完毕）：
   * baseUrl/apiKey/modelId 任一缺省回退启动配置（.env）；
   * contextTokens/maxOutputTokens/temperature/topP/topK 为 Provider 高级配置，缺省走默认
   */
  modelOverrides?: {
    baseUrl?: string
    apiKey?: string
    modelId?: string
    displayName?: string
    contextTokens?: number
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    /**
     * 免费池 key 清单（≥2 时启用 429 故障转移：同 URL 多账号 key，
     * 触发限流自动切换到下一个重试，不中断对话；详见 failoverFetch.ts）
     */
    apiKeys?: string[]
  }
  onFinish?: (event: { responseMessage: UIMessage; isAborted: boolean }) => void
  /** 每步结束回调（前端步骤进度条 / 达上限提醒；server 桥到 WS agent:step） */
  onStep?: (info: { step: number; total: number }) => void
  /** token 消耗快照（每步结束 + 流结束各推一次；server 桥到 WS agent:usage 供前端统计） */
  onUsage?: (snapshot: AgentUsageSnapshot) => void
  onError?: (error: unknown) => string
}

/** token 消耗快照：本轮累计 + 最近一次输入（≈上下文占用）+ 上下文构成估算 + 容量 */
export interface AgentUsageSnapshot {
  calls: number
  inputTokens: number
  outputTokens: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  lastInputTokens: number
  breakdown: { system: number; skills: number; tools: number; messages: number; other: number }
  capacity: { model: string; tokens: number }
  /** 本轮总耗时 ms（仅流结束的最终快照 >0；逐步快照为 0） */
  durationMs: number
}

/**
 * 粗估 token 数：CJK 字符 ≈0.6 token/字、其余（ASCII/标点/JSON 结构）≈0.28 token/字符。
 * 仅用于「上下文构成占比」展示，不做精确计账——精确消耗以 provider 返回的 usage 为准。
 */
function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return Math.round(cjk * 0.6 + (text.length - cjk) * 0.28)
}

export { modelContextTokens } from '@story-studio/shared'

/** Agent 调用选项：providerOptions 透传到模型（deepseek namespace 读 thinking/reasoningEffort）；
 *  temperature/topP/topK 为标准采样参数（仅配置时下发，openai-compatible 网关对不支持的参数自行忽略） */
type ProviderOptions = Record<string, Record<string, unknown>>
type AgentCallOptions = {
  providerOptions?: ProviderOptions
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
}

/** 单轮 Agent 循环的最大步骤数（模型调用次数）。stopWhen 到达即停止；任务未完成需用户回复「继续」续跑 */
export const MAX_STEPS = 80

/**
 * 清洗历史 UIMessage：把「未完成」的工具调用（无结果）转为 output-error 结果。
 * ai@7 的工具 part 是「调用+结果一体」：仅 state=output-available/output-error 携带结果，
 * 会话中断/审批未批完会留下 input-available/approval-requested/approval-responded 的裸调用——
 * SDK 构建 prompt 时校验失败抛 AI_MissingToolResultsError（流 0.1s 即炸）。
 * 转为错误结果而非直接剔除：模型能得知这些调用未生效（文件未写入），避免误判进度。
 */
export function sanitizeUiMessages(messages: UIMessage[]): UIMessage[] {
  type Part = Record<string, unknown> & { type?: string; toolCallId?: string; state?: string }
  const resultIds = new Set<string>()
  for (const m of messages) {
    for (const p of (m.parts ?? []) as Part[]) {
      const t = p.type ?? ''
      // 结果形态①：调用+结果一体的 part
      if (p.toolCallId && (p.state === 'output-available' || p.state === 'output-error')) {
        resultIds.add(p.toolCallId)
      }
      // 结果形态②：独立 result part（历史/兼容形态）
      if (p.toolCallId && (t === 'tool-result' || t.endsWith('-result'))) {
        resultIds.add(p.toolCallId)
      }
    }
  }
  let fixed = 0
  const cleaned = messages.map((m) => {
    const parts = ((m.parts ?? []) as Part[]).map((p): Part => {
      if (!(p.type ?? '').startsWith('tool-')) return p
      // 审批已响应（携带用户允许/拒绝决定、尚无输出）：必须原样保留——
      // SDK 据此（approval-responded + approval.approved）恢复工具循环并真正执行/拒绝工具。
      // output-denied（拒绝终态）同理保留。转成 output-error「中断」会摧毁审批决定
      // → 工具永不执行（写入无限「未执行」循环的根因之一）。
      if (p.state === 'approval-responded' || p.state === 'output-denied') return p
      if (!p.toolCallId || resultIds.has(p.toolCallId)) return p
      fixed += 1
      const { approval: _staleApproval, ...rest } = p
      void _staleApproval
      return {
        ...rest,
        state: 'output-error',
        errorText: '此工具调用因上一轮会话中断（页面关闭/审批未完成）而未执行，未产生任何效果。如仍需要请重新发起。',
      }
    })
    return { ...m, parts }
  })
  if (fixed > 0) {
    chatLog('warn', `[agent] 清洗历史消息：${fixed} 个未完成工具调用转为「中断」结果（防 MissingToolResultsError）`)
  }
  return cleaned as unknown as UIMessage[]
}

export class StoryAgentRuntime {
  private deps: StoryAgentDeps

  constructor(deps: StoryAgentDeps) {
    this.deps = deps
  }

  /**
   * 本步允许模型调用的工具名（模式白名单；能 load_skill 的模式额外暴露 Bash/tracking 代理——
   * 技能流程常指示跑质检脚本/提交追踪，缺位会让模型撞 NoSuchToolError 死循环）。
   */
  private activeToolsFor(mode: ModeId): string[] {
    const def = getMode(mode)
    const names = def.tools.includes('*') ? Object.keys(this.deps.tools) : [...def.tools]
    if (def.tools.includes('load_skill')) {
      for (const n of ['Bash', 'tracking']) {
        if (!names.includes(n) && this.deps.tools[n]) names.push(n)
      }
    }
    return names
  }

  /**
   * 模式门控代理：注册名与 schema/描述沿用真实工具，execute 在调用瞬间实时判定当前模式——
   * 允许则透传真实实现，否则返回引导文案（switch_mode 即时生效链路的执行侧）。
   * 与 prepareStep 每步重算的 activeTools（可见性侧）配合：模型看得见、调得动、切了就通。
   */
  private gatedProxy(
    name: string,
    hint: string,
    liveMode: { current: ModeId } | undefined,
    requestMode: ModeId,
  ): ToolSet[string] | undefined {
    const real = this.deps.tools[name]
    if (!real?.execute) return undefined
    return {
      ...real,
      execute: async (input, options) => {
        const mode = liveMode?.current ?? requestMode
        const def = getMode(mode)
        if (def.tools.includes('*') || def.tools.includes(name)) {
          return await real.execute!(input as never, options as never)
        }
        return `【工具不可用】${name} 在当前模式（${mode}）未启用。${hint}`
      },
    } as ToolSet[string]
  }

  /** 全量工具超集：Bash/tracking 换成模式门控代理，其余原样（可见性由 activeTools 按步裁剪） */
  private buildSupersetTools(liveMode: { current: ModeId } | undefined, requestMode: ModeId): ToolSet {
    const out: ToolSet = { ...this.deps.tools }
    const bash = this.gatedProxy(
      'Bash',
      '如需跑质检脚本/字数统计等命令行操作，请先调用 switch_mode 切换到创作模式；或改用 Read/Glob/Grep 等只读方式完成本模式目标。',
      liveMode,
      requestMode,
    )
    if (bash) out.Bash = bash
    const tracking = this.gatedProxy(
      'tracking',
      '如需提交/推进追踪事务（tracking commit 等），请先调用 switch_mode 切换到创作模式。',
      liveMode,
      requestMode,
    )
    if (tracking) out.tracking = tracking
    return out
  }

  /** 模式审批策略 → toolApproval 配置（运行中实时判定，重写需文件系统存在性检查）。
   * 注意：per-tool 审批函数是运行时逐调用求值的——传入 liveMode ref，
   * decide() 每次调用按「运行中模式」取策略，审批也能随 switch_mode 即时生效。
   */
  private buildToolApproval(liveMode: { current: ModeId }): ToolApprovalConfiguration<ToolSet, never> {
    const ws = this.deps.workspace
    const decide = (input: { path?: string }): boolean => {
      const def = getMode(liveMode.current)
      if (def.approval.kind === 'none') return false
      if (def.approval.kind === 'write-edit') return true
      // rewrite-only：目标文件已存在（改写）才停靠；新建放行
      const p = input?.path
      if (!p) return true
      return existsSync(isAbsolute(p) ? resolve(p) : resolve(ws, p))
    }
    return {
      Write: (input: { path?: string }) => (decide(input) ? 'user-approval' : undefined),
      Edit: (input: { path?: string }) => (decide(input) ? 'user-approval' : undefined),
      // 高危动作框架级审批（模式无关，恒停靠）：browser_cdp setup 会 kill 常规 Chrome，
      // 从提示词自觉升级为 toolApproval —— 前端 ApprovalCard 工具无关，自动渲染审批卡
      browser_cdp: (input: { action?: string }) => (input?.action === 'setup' ? 'user-approval' : undefined),
    } as unknown as ToolApprovalConfiguration<ToolSet, never>
  }

  /**
   * 请求消息集 = [目录消息(UIMessage, 持久前缀)] + 客户端历史 +（目录变更时）替换消息。
   * 目录以用户消息形态置于会话开头，前缀稳定 → provider KV Cache 友好；
   * 变更时在最后一条消息前插入完整替换清单（dsh 式，不改写历史）。
   */
  buildUiMessages(uiMessages: UIMessage[], previousCatalogDigest: string | null): UIMessage[] {
    const catalog = this.deps.skills.catalogText()
    const digest = this.deps.skills.digest()
    const out: UIMessage[] = [
      { id: 'skill-catalog', role: 'user', parts: [{ type: 'text', text: catalog }] },
      ...uiMessages,
    ]
    if (previousCatalogDigest !== null && previousCatalogDigest !== digest) {
      const replacement: UIMessage = {
        id: 'skill-catalog-replacement',
        role: 'user',
        parts: [{ type: 'text', text: `${catalog}\n\n（技能目录已更新：以上完整目录替换之前所有目录清单。）` }],
      }
      out.splice(Math.max(1, out.length - 1), 0, replacement)
    }
    return out
  }

  async chatStream(opts: ChatStreamOptions): Promise<Response> {
    const modelInfo = opts.modelOverrides ?? {}
    const baseUrl = modelInfo.baseUrl || this.deps.model.baseUrl
    const apiKey = modelInfo.apiKey || this.deps.model.apiKey
    const modelId = modelInfo.modelId || this.deps.model.modelId
    // 免费池（kind='free'，配置 ≥2 个 key）：走故障转移 fetch——任一 key 触发 429/503
    // 自动切换到下一个账号重试（同 URL），全程不中断对话；单 key 或普通模型不受影响
    const keyPool = Array.isArray(modelInfo.apiKeys) ? modelInfo.apiKeys.filter((k) => k.trim()) : []
    const useFailover = keyPool.length >= 2
    const fetchImpl = useFailover
      ? createFailoverFetch({ keys: keyPool, fetchImpl: normalizingFetch, label: modelId })
      : normalizingFetch
    // DeepSeek 官方 provider（3.x，ai v7 同代）：Chat Completions 格式 + 解析 reasoning_content
    // → 思维链作为 reasoning part 流入前端「思考过程」折叠块；thinking 默认 enabled（官方默认）。
    // baseURL 可指向任意 OpenAI 兼容网关（DeepSeek/Kimi/GLM 等）。
    // normalizingFetch：规范化网关不合规的流式分片（实测 SenseNova deepseek-v4-pro 的
    // tool_calls 首片 type:"" 会被 SDK 严格校验拒绝 → 整轮流中断；合规网关无感直通）。
    // failoverFetch：免费池模式下包在 normalizingFetch 外层，仅按响应态码轮换 Authorization 头。
    // opencode 网关（Console Go/Zen）强制要求 x-opencode-session 与会话级稳定 id + 自定义 UA，
    // 缺失报「Request is missing x-opencode-session」整轮失败（详见 gateway.ts）。
    const provider = createDeepSeek({
      baseURL: baseUrl,
      apiKey: useFailover ? keyPool[0]! : apiKey,
      fetch: fetchImpl,
      headers: opencodeGatewayHeaders(baseUrl, opts.sessionId),
    })
    const model = provider.chat(modelId)

    const instructions = buildSystemPrompt({
      mode: opts.mode,
      status: opts.status,
      preferences: opts.preferences,
      modeContext: opts.modeContext,
    })

    const liveMode = opts.modeRef ?? { current: opts.mode }
    const toolCount = this.activeToolsFor(opts.mode).length
    chatLog('info', `[agent] 请求 mode=${opts.mode} 模型=${modelId} 思考=${opts.reasoningEffort ?? 'max(默认)'} tools=${toolCount} 历史=${opts.messages.length} 条`)

    let lastStepMode: ModeId = opts.mode
    // 本 run 内逐次模型调用的 token 采集（onLanguageModelCallEnd）：含缓存命中拆分，结束时汇总落日志
    const usage = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    // 上下文构成估算（请求期一次测算，占比展示用）：系统提示 / 技能目录 / 工具定义 / 历史消息
    const catalogText = this.deps.skills.catalogText()
    const promptUiMessages = this.buildUiMessages(sanitizeUiMessages(opts.messages), opts.previousCatalogDigest)
    const messagesChars = promptUiMessages.reduce(
      (acc, m) => acc + JSON.stringify(m.parts ?? []).length,
      0,
    )
    let toolsChars = 0
    for (const n of this.activeToolsFor(opts.mode)) {
      const t = this.deps.tools[n]
      if (!t) continue
      toolsChars += (t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length
    }
    const breakdown = {
      system: estimateTokens(instructions),
      skills: estimateTokens(catalogText),
      tools: estimateTokens('x'.repeat(toolsChars)),
      messages: estimateTokens('x'.repeat(messagesChars)),
      other: 0,
    }
    // 上下文容量：Provider 显式配置优先（用户在设置面板填写的输入窗口），否则按模型 ID 识别
    const capacity = {
      model: modelId,
      tokens: opts.modelOverrides?.contextTokens ?? modelContextTokens(modelId),
    }
    let lastInputTokens = 0
    const emitUsage = (final = false) => {
      // 首步拿到 provider 真实输入后，把「其他」（角色标记/工具调用 JSON 包装/聊天模板）计为残差
      if (usage.calls >= 1 && breakdown.other === 0) {
        const known = breakdown.system + breakdown.skills + breakdown.tools + breakdown.messages
        breakdown.other = Math.max(0, usage.inputTokens - known)
      }
      opts.onUsage?.({
        ...usage,
        lastInputTokens,
        breakdown: { ...breakdown },
        capacity: { ...capacity },
        durationMs: final ? Date.now() - streamStartedAt : 0,
      })
    }
    const agent = new ToolLoopAgent<AgentCallOptions, ToolSet, never>({
      model,
      instructions,
      // 工具注册为全量超集（Bash/tracking 为门控代理）；每步可见范围由 prepareStep 按运行中模式重算
      tools: this.buildSupersetTools(liveMode, opts.mode),
      stopWhen: stepCountIs(MAX_STEPS),
      toolApproval: this.buildToolApproval(liveMode),
      // 真实 token 消耗打点：Agent 设置级 onStepEnd 每步收到 StepResult（含 usage + 缓存拆分；
      // provider 未返回缓存字段时为 0）；与 createAgentUIStreamResponse 的流式回调互不干扰
      onStepEnd: (event) => {
        usage.calls += 1
        usage.inputTokens += event.usage?.inputTokens ?? 0
        usage.outputTokens += event.usage?.outputTokens ?? 0
        const d = event.usage?.inputTokenDetails
        usage.noCacheTokens += d?.noCacheTokens ?? 0
        usage.cacheReadTokens += d?.cacheReadTokens ?? 0
        usage.cacheWriteTokens += d?.cacheWriteTokens ?? 0
        lastInputTokens = event.usage?.inputTokens ?? lastInputTokens
        emitUsage()
      },
      // switch_mode 即时生效：每步重算 可见工具集 + 系统提示词（含模式行为契约）；模式未变不重建提示词
      prepareStep: () => {
        const mode = liveMode.current
        if (mode !== lastStepMode) {
          chatLog('info', `[agent] 运行中模式切换：${lastStepMode} → ${mode}（下一步起工具集/提示词/审批策略即时生效）`)
          lastStepMode = mode
          return {
            activeTools: this.activeToolsFor(mode),
            instructions: buildSystemPrompt({ mode, status: opts.status, preferences: opts.preferences, modeContext: opts.modeContext }),
          }
        }
        return { activeTools: this.activeToolsFor(mode) }
      },
    })

    // 思考强度/thinking 经 providerOptions.deepseek 透传（模型级）；maxOutputTokens 直接传。
    // 思考默认拉满：未显式指定时 thinking=enabled + reasoningEffort=max
    const effort = (opts.reasoningEffort ?? 'max') as 'low' | 'high' | 'max'
    // 输出 token 上限三级优先：请求级覆盖 > Provider 配置 > 默认 16384。
    // 推理模型的思考 token 计入输出预算，不显式传时走 API/网关默认（常见 4K）——长思考
    // 会耗尽预算 → finish_reason=length 截断（历史实证：末 part 为 reasoning、无 text）。
    // 16K 对常见模型安全；写长章建议在 Provider 配置 32K。
    // 采样参数（temperature/topP/topK）仅 Provider 配置时下发；未配置不传 → 走服务端默认
    //（DeepSeek 默认 temperature≈1.0；小说创作推荐 temperature 1.3 + topP 0.95 提升文笔多样性）
    const mo = opts.modelOverrides
    const callOptions: AgentCallOptions = {
      maxOutputTokens: opts.maxOutputTokens ?? mo?.maxOutputTokens ?? 16_384,
      ...(mo?.temperature !== undefined ? { temperature: mo.temperature } : {}),
      ...(mo?.topP !== undefined ? { topP: mo.topP } : {}),
      ...(mo?.topK !== undefined ? { topK: mo.topK } : {}),
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' as const },
          reasoningEffort: effort,
        },
      },
    }

    const streamStartedAt = Date.now()
    let lastStepEndAt: number | null = null // 单步耗时 = 距上一步结束（此前误用累计值，误导排查）
    let lastErrSig = '' // 同一错误会被 SDK 两条管道（streamText 内部 + UI 流转换）各回调一次，按签名去重
    let lastErrAt = 0
    // 官方 Agent↔UIMessage 桥接：流式 + 审批请求/响应往返 + originalMessages 持久化模式
    return createAgentUIStreamResponse({
      agent,
      uiMessages: this.buildUiMessages(sanitizeUiMessages(opts.messages), opts.previousCatalogDigest),
      originalMessages: opts.messages,
      // 响应消息 id 生成：不传则 assistant 消息 id 为空串——持久化查重、前端 React key、
      // 审批续跑替换全部失效（SDK 设计：仅在「末条为 assistant」续跑时沿用其 id）
      generateMessageId: () => `msg-${randomUUID()}`,
      options: callOptions,
      onStepEnd: (event) => {
        const content = (event as unknown as { content?: unknown[] }).content ?? []
        const textLen = content
          .filter((p) => (p as { type?: unknown }).type === 'text')
          .map((p) => ((p as { text?: string }).text ?? ''))
          .join('').length
        const toolParts = content.filter((p) => {
          const t = (p as { type?: string }).type
          return typeof t === 'string' && t.startsWith('tool-')
        })
        const toolNames = toolParts.map((p) => {
          const t = (p as { type?: string }).type ?? ''
          // 真实工具名在 content part 的 toolName 字段——type 只是 tool-call/tool-result 通用形态，
          // 直接剥前缀只会得到 call/result，看不出具体动作
          const raw = (p as { toolName?: string }).toolName
          const n = raw && raw !== t ? raw : t.replace(/^tool-/, '')
          const st = (p as { state?: string }).state
          const tag =
            st === 'output-error' ? 'ERR' : st === 'approval-requested' ? '审批' : st === 'output-available' ? 'ok' : ''
          return tag ? `${n}(${tag})` : n
        })
        const approvals = content.filter((p) => (p as { type?: string }).type === 'tool-approval-request').length
        const now = Date.now()
        const stepMs = lastStepEndAt == null ? now - streamStartedAt : now - lastStepEndAt
        lastStepEndAt = now
        chatLog('info', `[agent] step#${event.stepNumber} 文本=${textLen}字 工具=[${toolNames.join(', ')}] 待审批=${approvals} 耗时=${stepMs}ms`)
        opts.onStep?.({ step: event.stepNumber, total: MAX_STEPS })
      },
      onFinish: (event) => {
        const totalMs = Date.now() - streamStartedAt
        chatLog('info', `[agent] 流结束 isAborted=${event.isAborted} 末消息parts=${event.responseMessage?.parts?.length ?? 0} 总耗时=${(totalMs / 1000).toFixed(1)}s`)
        if (usage.calls > 0) {
          chatLog(
            'info',
            `[agent] token 消耗：模型调用 ${usage.calls} 次 | 输入 ${usage.inputTokens}（缓存命中 ${usage.cacheReadTokens} / 未缓存 ${usage.noCacheTokens} / 写缓存 ${usage.cacheWriteTokens}）| 输出 ${usage.outputTokens}`,
          )
          emitUsage(true) // 最终快照（含累计/上下文占用/总耗时），桥到 WS agent:usage 并落盘
        }
        opts.onFinish?.({ responseMessage: event.responseMessage, isAborted: event.isAborted })
      },
      onError: (error) => {
        const msg = error instanceof Error ? error.message : String(error)
        const sig = `${error instanceof Error ? error.name : ''}:${msg.slice(0, 120)}`
        const now = Date.now()
        if (!(sig === lastErrSig && now - lastErrAt < 1000)) {
          lastErrSig = sig
          lastErrAt = now
          chatLog('error', `[agent] 流错误: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        }
        return opts.onError?.(error) ?? describeModelError(error, useFailover)
      },
    } as Parameters<typeof createAgentUIStreamResponse>[0])
  }
}

/**
 * 把模型端点常见错误翻成人话（工具不存在/401/403 鉴权、404 地址、429 限流、网络不通、协议校验），其余回退通用文案。
 * freePool=true：当前是免费池模型（多 key 已按 429 故障转移轮询过），限流走到这里说明整池都不可用——属服务方整体过载。
 */
function describeModelError(error: unknown, freePool = false): string {
  // NoSuchToolError：返回值会成为 errorText 回注给模型（不只是日志）——必须给出可自纠的明确指引，
  // 否则模型只看到「运行出错」会盲目重试 → 重复长考死循环。
  if (NoSuchToolError.isInstance(error)) {
    const avail = error.availableTools?.length ? `可用工具：${error.availableTools.join('、')}。` : ''
    return `工具「${error.toolName}」在当前模式不可用。${avail}请改用可用工具完成任务；如需完整工具集（Bash/tracking/写正文等），先调用 switch_mode 切换到创作模式。`
  }
  const e = error as { statusCode?: number; message?: string; responseBody?: string } | null
  const code = e?.statusCode
  const body = String(e?.responseBody ?? e?.message ?? '')
  if (code === 401 || code === 403 || /AuthError|Invalid API key|Unauthorized/i.test(body)) {
    return freePool
      ? '免费模型所有账号的 API Key 均鉴权失败（401/403）：某个 key 已失效或被服务方禁用。请到「模型设置」编辑该免费模型，核对每个 key 是否仍然有效（失效的及时删除）。'
      : '模型服务鉴权失败（401/403）：API Key 无效，或 Key 与 baseURL 不是同一家。请打开「模型设置」核对该 Provider 的 API Key 与 baseURL（常见坑：官方模型却配了中转站地址、或复用了别家的 key）。'
  }
  if (code === 404) {
    return '模型服务返回 404：baseURL 可能不正确（注意 /v1 等路径是否与该服务商文档一致）。请到「模型设置」检查。'
  }
  // 限流（429 / TPM 配额耗尽）：模型服务方每分钟 token 用量配额被打满，属「模型服务自身问题」、
  // 与本应用/Agent 无关——重发无效（SDK 已按指数退避重试过），须等窗口或换 Provider。
  // ⚠ 实测（2026-09-02 a7482c08）：webai_draw 生图完成后恢复模型调用即撞「inference tpm exhausted」
  //   （AI_RetryError 内层消息），此前 9-1 亦两次同错——须给用户明确归因，不能落通用兜底误导为 Agent 故障。
  if (code === 429 || /tpm exhausted|rate.?limit|too many requests|throttl|insufficient.?quota/i.test(body)) {
    return freePool
      ? '免费模型池内所有账号 key 均被限流（429）：该时段服务方使用人数过多，各账号共享限流。已在本轮内自动轮询切换全部 key 重试，稍等片刻（约 1-2 分钟）后回复「继续」即可续跑；也可到「模型设置」为该免费模型补充更多账号的 key 提升可用性。'
      : '模型服务限流（429 / TPM 配额耗尽）：模型服务方每分钟 token 用量配额被打满，这是模型服务自身的问题，与本应用/Agent 无关。请等待 1-2 分钟后再试，或到「模型设置」切换到其他 Provider（如官方 DeepSeek / opencode 网关）。'
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(body)) {
    return '无法连接模型服务：请检查网络/代理与 baseURL 是否可达。'
  }
  // Vercel AI SDK 类型校验失败：所选模型/网关返回的数据不符合协议（常见于流式工具调用分片非法）。
  // 这类是「模型服务自身问题」而非临时波动，重发无效——必须明确告诉用户换模型/网关，否则会反复报同样的错。
  const errName = error instanceof Error ? error.name : ''
  const errMsg = error instanceof Error ? error.message : String(error ?? '')
  if (errName === 'AI_TypeValidationError' || /Type validation failed/i.test(errMsg)) {
    if (/(tool_calls|tool):[^]*/i.test(errMsg) || errMsg.includes('tool_calls')) {
      return '模型返回了格式非法的工具调用（tool_calls 缺少 type:"function"）。这通常说明【当前模型/网关的工具调用协议不兼容】，不是临时波动，重发无效。请到「模型设置」更换为支持 OpenAI 工具调用的模型（如 deepseek-chat / glm-5.3-flash），或更换 baseURL 网关后重试。'
    }
    return '模型返回的数据不符合协议（类型校验失败），多为网关对该模型的响应不规范。请到「模型设置」核对 baseURL 与其 modelId 是否匹配，或更换模型/网关后重试。'
  }
  return '⚠ Agent 运行出错，请查看服务端日志。'
}
