/** 聊天面板：useChat 流式 + 消息/工具卡片渲染 + 审批停靠 + 门禁红牌（回滚） */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import MarkdownIt from 'markdown-it'
import type { GateReport, ModeId, WsEvent } from '@story-studio/shared'
import { fetchHistory, fetchWorkspaceFile, rollbackSnapshot, submitAskAiAnswer } from '../api.ts'
import { DiffView } from '../components/DiffView.tsx'
import { Icon } from '../components/Icon.tsx'
import { PetMascot } from './PetMascot.tsx'
import { usePetState, PET_STATES, type PetState, type RoutePhase, DONE_HOLD_MS } from './usePetState.ts'
import { usePetPrefs } from './petPrefs.ts'
import { ToolCard, type ToolPartLike } from './ToolCard.tsx'
import { ToolCallsBar } from './ToolCallsBar.tsx'
import { summarizeToolPart } from './toolMeta.ts'
import { AgentRunIndicator, type RunOutcome, type RunUsageSnapshot } from './AgentRunIndicator.tsx'
import { ChatComposer, type ComposerSendOpts } from './ChatComposer.tsx'
import { playAlertSound } from './soundAlert.ts'
import type { RunLive, RunLiveCall, RunLiveItem } from './RunLive.ts'
import { wfStepOfTool } from '../panels/WorkflowPanel.tsx'

/** 发送前路由结果（App.preRoute 回传：是否切换了模式 + 命中层） */
export interface RouteSendOutcome {
  switched: boolean
  used?: string
}

/** AI 消息 Markdown 渲染（html 关闭防注入；与报告面板同配置） */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false })


/** 启发式检测：assistant 消息末尾是否在向用户提问（等待输入），用于「需回复」提示 */
function looksLikeAwaitingReply(text: string | undefined): boolean {
  if (!text) return false
  const tail = text.replace(/\s+/g, ' ').slice(-180)
  if (/[？?]\s*$/.test(tail)) return true
  return /(请回答|请回复|请确认|请你|由你|你来|拍板|你定|你决定|告诉我|回复我|等你|等待你|请选择|认可否|可否|好不好)/.test(tail)
}

/** 单项是否像问题（含疑问信号） */
function isQuestionItem(s: string): boolean {
  return /[？?]|是否|要不要|可不可以|好吗|好不好|行不行|认可否|可否|同意|可以吗|介意|请确认/.test(s)
}

/**
 * 从 assistant 文本提取"问题列表"（问答表单数据源）。
 * 支持两种形态：
 *   A. 编号/符号列表项（1. / - / *）：块内疑问项 ≥2 且占比 ≥ 一半；
 *   B. 无编号问句行（独立一行、以 ？/? 结尾、≤100 字）：连续 ≥2 行即问题块。
 * 标题取最近的小节标题（含"决策点/拍板/确认/需要你"的行），兜底「Agent 向你提问」。
 */
function extractQuestions(text: string): { title: string; questions: string[] } | null {
  const blocks: Array<{ title: string; items: string[] }> = []
  let cur: { title: string; items: string[] } | null = null // A. 列表块
  let curQ: { title: string; items: string[] } | null = null // B. 问句行块
  let lastTitle = 'Agent 向你提问'

  const flush = () => {
    if (cur && cur.items.length >= 2) blocks.push(cur)
    if (curQ && curQ.items.length >= 2) blocks.push(curQ)
    cur = null
    curQ = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const tr = raw.trim()
    if (!tr) {
      flush()
      continue
    }
    // markdown 标题（#）
    const heading = /^#{1,6}\s+(.+)$/.exec(tr)?.[1]
    if (heading) {
      flush()
      lastTitle = heading.replace(/[【】\[\]<>《》#]/g, '')
      continue
    }
    // 提问小节标题：形如「三、需要你拍板的 5 个决策点」（不以问号收尾，避免吞掉问句行）
    const askTitle = /^(?:[一二三四五六七八九十]+[、.．]\s*)?(.{0,30}?(?:决策点|拍板|确认|选择|需要你|请你).{0,30}?)$/.exec(tr)?.[1]
    if (askTitle && !/^[-*\d]/.test(tr) && !/[？?]$/.test(tr)) {
      flush()
      lastTitle = askTitle
      continue
    }
    // A. 列表项
    const item = /^(?:\d+[.、）)]\s*|[-*+]\s+)(.+)$/.exec(tr)?.[1]
    if (item) {
      if (curQ) flush()
      if (!cur) cur = { title: lastTitle, items: [] }
      cur.items.push(item)
      continue
    }
    // B. 无编号问句行：短行 + 问号收尾，连续 ≥2 行成块
    const qLine = tr.length <= 100 && /[？?]\s*$/.test(tr)
    if (qLine) {
      if (cur) flush()
      if (!curQ) curQ = { title: lastTitle, items: [] }
      curQ.items.push(tr)
      continue
    }
    flush()
  }
  flush()

  // 最优块：疑问项 ≥2 且占比 ≥ 一半（全问句优先）
  let best: { title: string; questions: string[] } | null = null
  let bestScore = 0
  for (const b of blocks) {
    const qs = b.items.filter(isQuestionItem)
    if (qs.length < 2 || qs.length / b.items.length < 0.5) continue
    const score = qs.length + (qs.length === b.items.length ? 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      best = { title: b.title, questions: b.items }
    }
  }
  return best
}

/** 秒数 → 人类可读时长（≥1 分钟转 分/时） */
function fmtDuration(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分${String(r).padStart(2, '0')}秒`
  if (m > 0) return `${m}分${String(r).padStart(2, '0')}秒`
  return `${r}秒`
}

function isToolPart(part: unknown): part is ToolPartLike {
  return (
    typeof part === 'object' &&
    part !== null &&
    typeof (part as { type?: unknown }).type === 'string' &&
    (part as { type: string }).type.startsWith('tool-') &&
    (part as { type: string }).type !== 'tool-approval-request' &&
    (part as { type: string }).type !== 'tool-approval-response'
  )
}

/**
 * 待决审批检测（ai@7 客户端真实形态）：
 * 客户端 processUIMessageStream 收到 tool-approval-request 事件后不生成独立 part，
 * 而是把对应工具 part（如 tool-Write）置 state='approval-requested' 并挂 approval.id。
 */
function isPendingApprovalPart(part: unknown): boolean {
  return (
    isToolPart(part) &&
    part.state === 'approval-requested' &&
    typeof part.approval?.id === 'string'
  )
}

/** 可折叠进「工具任务栏」的普通工具 part：非审批态、非问答表单（审批/表单需独立可见可操作） */
function isBarToolPart(part: unknown): part is ToolPartLike {
  if (!isToolPart(part)) return false
  const t = part.type
  if (t === 'tool-ask_questions' || t === 'tool-ask_confirm') return false
  if (part.state === 'approval-requested' || part.state === 'approval-responded') return false
  return true
}

/**
 * 把 parts 里的「连续普通工具」折叠为 ToolCallsBar（彩色图标任务栏），其余 part 交 renderOne 单独渲染。
 * live=执行中（任务栏默认展开 + 实时当前动作）。保持原顺序。
 */
function collapseToolRuns(
  parts: UIMessage['parts'],
  live: boolean,
  renderOne: (part: UIMessage['parts'][number], idx: number) => React.ReactNode,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let run: ToolPartLike[] = []
  const flush = () => {
    if (run.length > 0) {
      out.push(<ToolCallsBar key={`tcb-${run[0]!.toolCallId ?? out.length}`} parts={run} live={live} />)
      run = []
    }
  }
  parts.forEach((part, idx) => {
    if (isBarToolPart(part)) run.push(part)
    else {
      flush()
      out.push(renderOne(part, idx))
    }
  })
  flush()
  return out
}

export function ChatPanel({
  sessionId,
  mode,
  onMessages,
  pendingLoad,
  pendingPrompt,
  onBeforeSend,
  wsEvent,
  models,
  activeModelId,
  composerInsert,
  reasoningEfforts,
  workspace,
  onPetLive,
  onJumpChapter,
  onRunLive,
}: {
  sessionId: string
  mode: ModeId
  onMessages?: (messages: UIMessage[]) => void
  pendingLoad?: { id: string; messages: UIMessage[] } | null
  /** 外部面板（导入向导等）的代理发送（nonce 触发，同一 nonce 只发一次） */
  pendingPrompt?: { text: string; nonce: number } | null
  onBeforeSend?: (text: string) => Promise<RouteSendOutcome | void> | RouteSendOutcome | void
  wsEvent?: WsEvent | null
  /** 可选模型（输入栏切换）= 用户配置的 Provider；value 为 providerId */
  models?: Array<{ id: string; label: string; modelId: string; supportsImages?: boolean; free?: boolean }>
  /** 激活 Provider id（未手动切换时的默认模型；决定图片附件默认可用性） */
  activeModelId?: string
  /** 资源管理器右键「添加到对话」：nonce 变化时把 @路径 引用插入输入框（透传 Composer） */
  composerInsert?: { path: string; nonce: number } | null
  /** 思考强度候选 */
  reasoningEfforts?: Array<{ id: string; label: string }>
  /** 书工作区绝对路径（输入栏 @ 引用工作区文件） */
  workspace?: string
  /** 宠物实时状态上报（顶栏胶囊 Agent 段复用同一仲裁结果；elapsed 运行中每 0.5s 跳动） */
  onPetLive?: (s: { state: PetState; elapsed: number }) => void
  /** 交付卡「去阅读本章」：跳转右侧阅读器到指定章节（App 桥接到 WorkPanel） */
  onJumpChapter?: (chapter: number) => void
  /** 运行实时快照上报（工作流视图点亮用：当前工具/动作/写作章号/本轮步骤） */
  onRunLive?: (live: RunLive) => void
}): React.JSX.Element {
  const sessionIdRef = useRef(sessionId)
  const modeRef = useRef(mode)
  sessionIdRef.current = sessionId
  modeRef.current = mode
  const modelRef = useRef('')
  const effortRef = useRef('max')
  /** 空回复提示：模型/网关偶发返回空时结束「卡住无反馈」（桌宠收起由下方 status 监听自动处理） */
  const [emptyReply, setEmptyReply] = useState<string | null>(null)
  /** 标记本轮是否已有具体错误被 onError 展示过；onFinish 空回复兜底据此不重复覆盖 */
  const errorHandledRef = useRef(false)
  /** 浏览器人工登录交接卡片：browser_login 工具触发（browser:login-required WS 事件），登录完成自动消失 */
  const [loginReq, setLoginReq] = useState<{ message: string } | null>(null)
  /** ask_ai 网页 AI 生成超时对话框：browser:ask-ai-waiting 触发，用户点「继续/放弃」回传 */
  const [askAiWait, setAskAiWait] = useState<{ site?: string; waitedSec?: number } | null>(null)
  /** 等待用户提交中（防连点） */
  const [askAiSubmitting, setAskAiSubmitting] = useState(false)

  const { messages, sendMessage, setMessages, status, stop, error, addToolApprovalResponse } =
    useChat({
      transport: new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({
          sessionId: sessionIdRef.current,
          mode: modeRef.current,
          ...(modelRef.current ? { providerId: modelRef.current } : {}),
          ...(effortRef.current && effortRef.current !== 'max' ? { reasoningEffort: effortRef.current } : {}),
        }),
      }),
      // 审批响应后自动续发（缺省 false：addToolApprovalResponse 只改本地消息，Agent 永远停着）
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      // 流/模型错误 → 展示服务端翻好的可读错误（换模型指引等），不再笼统说"瞬时波动"
      onError: (error) => {
        if (errorHandledRef.current) return
        errorHandledRef.current = true
        const msg = error instanceof Error ? error.message : String(error ?? '')
        // 用户主动停止/正常中断不算需要提示的错误
        if (/已被用户停止|aborted/i.test(msg)) return
        runErrorRef.current = true
        setEmptyReply(`⚠ ${msg}`)
      },
      onFinish: ({ message }) => {
        const parts = message.parts ?? []
        const st = (p: unknown) => (p as { state?: string }).state
        // 图片附件仅本轮注入：本轮 user 消息的 file part 在流结束后剥离（防后续请求/落盘重传 base64）
        if (imageStripIdRef.current) {
          const id = imageStripIdRef.current
          imageStripIdRef.current = null
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, parts: m.parts.filter((p) => p.type !== 'file') } : m)),
          )
        }
        // 已有具体错误（onError 已展示），空回复兜底不再覆盖
        if (errorHandledRef.current) return
        // 审批停靠是正常流程（等待批准），不算空回复
        if (parts.some((p) => st(p) === 'approval-requested')) return
        // 截断检测：消息以思考块结尾（思考后无任何 text/工具调用）——推理模型输出
        // 预算耗尽（finish_reason=length，思考占满 max_tokens）或思考后空响应。
        // 表现为任务"无声暂停"：工具结果都在但 Agent 不再动作；按出错定格（指示器
        // FAILED），并明确告知回复「继续」可续跑（上下文完整保留）。
        const lastMeaningful = [...parts].reverse().find((p) => p.type !== 'step-start')
        if (lastMeaningful?.type === 'reasoning') {
          runErrorRef.current = true
          setEmptyReply(
            '⚠ 模型输出被截断——思考占满了输出 token 上限，未产出任何动作。直接回复「继续」即可从此处续跑（已读取的资料与网页 AI 初稿都保留）；若反复出现，建议换模型或提高思考档位。',
          )
          return
        }
        const hasText = parts.some((p) => p.type === 'text' && 'text' in p && (p as { text: string }).text.trim().length > 0)
        const hasTool = parts.some((p) => p.type.startsWith('tool-') && st(p) === 'output-available')
        if (parts.length === 0 || (!hasText && !hasTool)) {
          // 无具体错误但确实没产出：给出处理建议（多数是模型/网关空响应），不再误导为"瞬时波动请重发"
          runErrorRef.current = true // 空回复也按出错结局定格（执行指示器 FAILED 而非 COMPLETED）
          setEmptyReply('Agent 未返回任何内容（无文本也无工具输出）。这多为所选模型/网关的空响应，重发通常仍会复现——建议在「模型设置」更换一个模型再试。')
        }
      },
    })

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户上翻查看历史时暂停自动跟随；回到底部恢复 */
  const pausedScrollRef = useRef(false)
  const [canJump, setCanJump] = useState(false)
  useEffect(() => {
    if (!pausedScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages])
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    pausedScrollRef.current = !nearBottom
    setCanJump(!nearBottom)
  }
  /** 滚轮向上即暂停自动跟随（避免与流式滚动动画打架，用户上翻立即可用） */
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      pausedScrollRef.current = true
      setCanJump(true)
    }
  }
  const jumpToBottom = () => {
    pausedScrollRef.current = false
    setCanJump(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    // 只在消息【数量】变化时通知（流式 chunk 只更新 part、length 不变）：
    // 旧依赖 [messages] 会在每个流式 chunk 触发一次 → onMessages → refreshSessions →
    // 一轮流式几百个并发 /api/sessions fetch → 连接打爆 ERR_INSUFFICIENT_RESOURCES
    // （表现为资源管理器/可视化全部加载失败、文件树空白）
    onMessages?.(messages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onMessages])

  /** 外部会话切换时：载入历史（pendingLoad 命中）或清空 */
  const loadedRef = useRef('')
  useEffect(() => {
    if (sessionId !== loadedRef.current) {
      loadedRef.current = sessionId
      setMessages(pendingLoad && pendingLoad.id === sessionId ? pendingLoad.messages : [])
      // 清上一会话的定格/消耗/交付残留（执行指示器与交付卡不跨会话显示旧数据）
      setLastRun(null)
      setRunUsage(null)
      setDelivery(null)
      setDeliveryRev(null)
    }
  }, [sessionId, pendingLoad, setMessages])

  /** 外部面板代理发送：nonce 变化即发送（导入向导等场景，走同一条路由/模式链路） */
  const sentNonceRef = useRef(0)
  useEffect(() => {
    if (!pendingPrompt || !pendingPrompt.nonce || sentNonceRef.current === pendingPrompt.nonce) return
    if (status === 'streaming') return
    sentNonceRef.current = pendingPrompt.nonce
    void sendWithRoute(pendingPrompt.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt?.nonce])

  /** 审批：只统计「最后一条 assistant 消息」的未决请求（历史审批已处理/过期，不要求重复确认） */
  const lastMsg = messages.at(-1)
  /** 最后一条 assistant 消息：只有它的审批请求是可操作的（历史已处理/过期的审批不再要求确认） */
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant') ?? lastMsg

  const pendingApprovals = (lastAssistantMsg?.parts ?? []).filter(isPendingApprovalPart)
  const pendingApprovalLeft = pendingApprovals.length
  /** 批量条只在「最后一条 assistant 消息」渲染时的未决审批 */
  const msgApprovalsForBatch = pendingApprovals
  /** 批量审批去重：SDK 尚未把 part 转成 responded 的窗口内连点可重复提交同一批，按 approval id 缓存已响应 */
  const batchRespondedRef = useRef(new Set<string>())
  const respondBatch = (approved: boolean) => {
    msgApprovalsForBatch.forEach((p) => {
      const id = (p as ToolPartLike).approval!.id
      if (batchRespondedRef.current.has(id)) return
      batchRespondedRef.current.add(id)
      addToolApprovalResponse({ id, approved })
    })
  }

  /** 「完全允许」：本会话 Write/Edit 审批自动放行（默认手动；优化模式不可用——升华支路的作者批准
   *  承载免检语义，自动放行会破坏它；浏览器等高危审批也不自动放行） */
  const [autoAllow, setAutoAllow] = useState(false)
  const autoAllowAvailable = mode !== 'polish'
  /** 待决审批 id 签名（effect 依赖：新审批到达即触发自动放行） */
  const apSig = pendingApprovals.map((p) => (p as ToolPartLike).approval?.id ?? '').join('|')
  useEffect(() => {
    if (!autoAllow || !autoAllowAvailable || status === 'streaming' || pendingApprovals.length === 0) return
    const targets = pendingApprovals.filter((p) => {
      // 工具名在 part.type 里（如 tool-Write），ToolPartLike 没有 toolName 字段
      const name = (p as ToolPartLike).type.replace(/^tool-/, '')
      return name === 'Write' || name === 'Edit'
    })
    if (targets.length === 0) return
    // 短延迟：审批卡先渲染一瞬再自动放行（用户能看到发生了什么，也可在间隙手动处理）
    const t = setTimeout(() => {
      targets.forEach((p) => {
        const id = (p as ToolPartLike).approval!.id
        if (batchRespondedRef.current.has(id)) return
        batchRespondedRef.current.add(id)
        addToolApprovalResponse({ id, approved: true })
      })
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAllow, autoAllowAvailable, status, pendingApprovals.length, apSig])

  /** 待回复检测：最后一条 assistant 文本消息在向用户提问（流式未结束时不算） */
  const lastAssistantText =
    lastMsg && lastMsg.role === 'assistant'
      ? lastMsg.parts
          .filter((p) => p.type === 'text' && 'text' in p)
          .map((p) => (p as { text: string }).text)
          .join('\n')
      : ''
  const awaiting = status !== 'streaming' && !!lastAssistantText && looksLikeAwaitingReply(lastAssistantText)
  /** 表单出现判定：①模型调用了 ask_questions 工具（消息流内嵌表单）②启发式文本提取（兜底） */
  const hasQTool = messages.some((m) => m.parts.some((p) => p.type === 'tool-ask_questions'))
  const qBlock = awaiting && !hasQTool ? extractQuestions(lastAssistantText) : null

  /** 统一发送入口（问答表单/兜底表单/提问提示/主输入框共用）+ 路由桌宠状态机：
   *  preparing（识别意图）→ working（Agent 工作：submitted/streaming 全程显示）→ done（就绪亮相 1.1s）→ 卸载。
   *  防连点：路由/工作期间忽略后续 send（busy ref 同帧立即可见）。 */
  const [routePhase, setRoutePhase] = useState<'idle' | RoutePhase>('idle')
  const routeBusyRef = useRef(false)
  /** 本次路由是否命中（working 结束决定显示 done 还是直接卸载） */
  const hitUsedRef = useRef<string | undefined>(undefined)
  const endRoute = () => {
    routeBusyRef.current = false
    hitUsedRef.current = undefined
    setRoutePhase('idle')
  }
  /** 本轮带图 user 消息 id：流结束后在 onFinish 剥离 image part（仅本轮注入） */
  const imageStripIdRef = useRef<string | null>(null)
  const sendWithRoute = async (text: string, opts?: ComposerSendOpts) => {
    if (routeBusyRef.current) return
    setEmptyReply(null) // 新发送清除上次空回复提示
    runStoppedRef.current = false // 新一轮清除上轮结局标记
    runErrorRef.current = false
    routeBusyRef.current = true
    hitUsedRef.current = undefined
    setRoutePhase('preparing')
    // 网页 AI 胶囊（通道 B 显式标记）：文本未含触发词时自动前置「用网页AI」；
    // 站点/模型选择一并写进前缀，Agent 据此传 ask_ai 的 site / model 参数
    const webAiTag = opts?.webAi
      ? `用网页AI${opts.webAiSiteLabel ? `（${opts.webAiSiteLabel}${opts.webAiModel ? ` · ${opts.webAiModel}` : ''}）` : ''}：`
      : ''
    const finalText = opts?.webAi && !/用\s*网页\s*AI|网页AI/.test(text) ? `${webAiTag}${text}` : text
    try {
      try {
        const outcome = await onBeforeSend?.(finalText)
        if (outcome?.switched) {
          hitUsedRef.current = outcome.used
        }
      } catch {
        // 路由建议失败（网络/渲染异常）：保持当前模式继续发送，不阻塞、不锁死桌宠
      }
    } finally {
      try {
        if (opts?.images?.length) {
          // 图片附件：sendMessage 带 files（FileUIPart）构造多模态 user 消息；messageId 记录用于流结束剥离
          const imageMsgId = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          imageStripIdRef.current = imageMsgId
          void sendMessage({
            text: finalText,
            files: opts.images.map((img, i) => {
              const m = /^data:(image\/[\w.+-]+);base64,/.exec(img)
              const mediaType = m?.[1] ?? 'image/png'
              const ext = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
              return { type: 'file' as const, mediaType, url: img, filename: `attachment-${i + 1}.${ext}` }
            }),
            messageId: imageMsgId,
          })
        } else {
          sendMessage({ text: finalText }) // 命中与否都立即发送，preparing→working 由下方 status 监听接管
        }
      } catch {
        endRoute() // 发送同步失败：解锁桌宠，否则 preparing 永久卡死并锁死发送入口
      }
    }
  }
  // 路由成功后由 status 驱动：preparing → working（进入 Agent 工作）→ done/卸载（工作结束）
  const prevWorkingRef = useRef(false)
  useEffect(() => {
    const nowWorking = status === 'submitted' || status === 'streaming'
    const prev = prevWorkingRef.current
    prevWorkingRef.current = nowWorking
    if (!routeBusyRef.current) return
    if (!prev && nowWorking) {
      setRoutePhase('working')
    } else if (prev && !nowWorking) {
      // 手动停止/出错：跳过 done 庆祝（桌宠不该在失败/终止后亮相「完成」happy 态）
      if (runStoppedRef.current || runErrorRef.current) endRoute()
      else if (hitUsedRef.current !== undefined) setRoutePhase('done')
      else endRoute()
    }
  }, [status])
  // 看门狗：preparing 停留超过 10s（路由预算 5s + 客户端 6s 兜底 + 余量）仍未进入 working，
  // 说明发送链路异常（status 从未经过 submitted/streaming）→ 强制卸载桌宠解锁发送，避免死锁
  useEffect(() => {
    if (routePhase !== 'preparing') return
    const t = setTimeout(endRoute, 10_000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePhase])
  // 自愈看门狗：done 亮相回收不能依赖桌宠计时——若该轮回复被判为「等待用户回复」(asking 高优先级抢占)，
  // usePetState 的 raw 恒为 asking、done 回收计时从不启动，routePhase 永久卡 done → sending 恒 true → 输入锁死。
  // 此处独立保证 done 到点必回收（endRoute 幂等，桌宠正常走完 1.1s 也不受影响）
  useEffect(() => {
    if (routePhase !== 'done') return
    const t = setTimeout(endRoute, DONE_HOLD_MS + 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePhase])

  /** 本轮实时耗时（streaming 期间每 0.5s 刷新）；一轮结束定格，挂到该轮 assistant 消息下方展示 */
  const [elapsed, setElapsed] = useState(0)
  /** 上轮定格：任务真正结束才有（审批/表单停靠不算）；msgId=null 表示无 assistant 消息（如模型秒失败） */
  const [lastRun, setLastRun] = useState<{ msgId: string | null; seconds: number; outcome: RunOutcome } | null>(null)
  /** 本轮结局标记（run 结束时定格到 lastRun.outcome）：手动停止 / 模型出错·空回复 */
  const runStoppedRef = useRef(false)
  const runErrorRef = useRef(false)
  /** Agent 单轮步骤进度（WS agent:step 驱动）：{step, total}，达上限即提醒「回复继续」 */
  const [runSteps, setRunSteps] = useState<{ step: number; total: number } | null>(null)
  /** Agent 执行指示器（brutalist 面板）本轮 token 消耗快照：WS agent:usage 逐步推送（sessionId 过滤），
   *  任务完成后保留（hover 展开查看最终快照），下一轮 submitted 时清除 */
  const [runUsage, setRunUsage] = useState<RunUsageSnapshot | null>(null)
  const runUsageRef = useRef<RunUsageSnapshot | null>(null)
  /** 任务累计 token：跨「审批/表单续跑」各轮之和（用户反馈：问答续跑后指示器重置成占位符，
   *  应像耗时一样整任务连续显示——新任务清零、续跑折入 base、显示 base+当前轮） */
  const [baseUsage, setBaseUsage] = useState<RunUsageSnapshot | null>(null)
  /** 上一 run 是否真正结束：true=下次 submitted 是新任务（清零 base）；false=续跑（折入 base） */
  const taskEndedUsageRef = useRef(true)
  /** 本轮交付（WS gate:result passed 且为章节文件）：任务结束后渲染交付卡（字数/门禁/追踪/耗时 + 朱印） */
  const [delivery, setDelivery] = useState<{ chapter: number; file: string } | null>(null)
  /** 最近一次追踪修订号（WS tracking:updated）：交付卡 rev 展示 */
  const [deliveryRev, setDeliveryRev] = useState<number | null>(null)

  const runStartRef = useRef(0)
  /** 跨「待用户输入交互」（审批/提问/确认表单）的累计执行毫秒——任务被表单打断续跑时不清零，保证总耗时连续 */
  const accMsRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /** 最后一条 assistant 消息是否仍挂着「待用户输入」交互（待批审批 / ask_questions / ask_confirm 表单）：
   *  有 → 任务暂停等用户输入，结束只累计不清零；无 → 任务真正结束，定格总耗时 */
  const hasPendingUserInput = (msgs: UIMessage[]): boolean => {
    const last = msgs[msgs.length - 1]
    if (!last || last.role !== 'assistant') return false
    return last.parts.some((p) => {
      if (isPendingApprovalPart(p)) return true
      const t = (p as { type?: string }).type
      return t === 'tool-ask_questions' || t === 'tool-ask_confirm'
    })
  }

  useEffect(() => {
    // 新 run 开始 → 清掉上一轮的进度/上限/token 消耗/交付残留；
    // token 任务累计：新任务清零 base；续跑（审批/表单回答触发）把上一轮 runUsage 折入 base，
    // 指示器跨轮连续显示（不再回退到「首步尚未返回」占位符）
    if (status === 'submitted') {
      setRunSteps(null)
      if (taskEndedUsageRef.current) {
        setBaseUsage(null)
      } else {
        const prev = runUsageRef.current
        if (prev && prev.calls > 0) {
          setBaseUsage((b) =>
            b
              ? {
                  ...prev,
                  calls: b.calls + prev.calls,
                  inputTokens: b.inputTokens + prev.inputTokens,
                  outputTokens: b.outputTokens + prev.outputTokens,
                  noCacheTokens: b.noCacheTokens + prev.noCacheTokens,
                  cacheReadTokens: b.cacheReadTokens + prev.cacheReadTokens,
                  cacheWriteTokens: b.cacheWriteTokens + prev.cacheWriteTokens,
                }
              : { ...prev },
          )
        }
      }
      taskEndedUsageRef.current = false
      runUsageRef.current = null
      setRunUsage(null)
      setDelivery(null)
      setDeliveryRev(null)
    }
    if (status === 'submitted' || status === 'streaming') {
      // submitted→streaming 不重置起点（排队等待时间也计入总耗时）；延续上一段累计
      if (!runStartRef.current) runStartRef.current = Date.now()
      setElapsed(Math.floor((accMsRef.current + Date.now() - runStartRef.current) / 1000))
      const t = setInterval(
        () => setElapsed(Math.floor((accMsRef.current + Date.now() - runStartRef.current) / 1000)),
        500,
      )
      return () => clearInterval(t)
    }
    // 一轮结束（完成/停止/出错）：先把本段耗时并入累计
    if (runStartRef.current) {
      accMsRef.current += Date.now() - runStartRef.current
      runStartRef.current = 0
    }
    // 仍挂待用户输入（审批/提问表单）：任务暂停等用户，保留累计，等续跑接着计
    if (hasPendingUserInput(messagesRef.current)) {
      setElapsed(Math.floor(accMsRef.current / 1000))
      return
    }
    // 任务真正结束：定格累计耗时 + 结局到该轮 assistant 消息，并清零累计。
    // 结局分类：手动停止 > 模型出错/空回复 > 成功；无 assistant 消息（如模型秒失败）也定格
    // msgId=null——执行指示器仍要给出 FAILED 终态，而不是什么都不显示
    const secs = Math.max(1, Math.round(accMsRef.current / 1000))
    const outcome: RunOutcome = runStoppedRef.current ? 'stopped' : runErrorRef.current ? 'error' : 'success'
    const last = messagesRef.current[messagesRef.current.length - 1]
    setLastRun({ msgId: last?.role === 'assistant' ? last.id : null, seconds: secs, outcome })
    accMsRef.current = 0
    setElapsed(0)
    // 任务真正结束：下次 submitted 是新任务（token 累计清零，不再折入 base）
    taskEndedUsageRef.current = true
  }, [status])

  /** 工作中 = 已提交请求（等待首选响应）或流式中（均有动态提示） */
  const working = status === 'submitted' || status === 'streaming'

  /** 本次任务的 token 消耗（base 折入的此前轮 + 当前轮；上下文占用/容量取最近快照）——
   *  指示器与交付卡共用：续跑轮开始时当前轮尚未返回也先显示 base，不再回退占位符 */
  const taskUsage = useMemo<RunUsageSnapshot | null>(() => {
    const cur = runUsage && runUsage.calls > 0 ? runUsage : null
    if (!baseUsage && !cur) return null
    const sum = (k: 'calls' | 'inputTokens' | 'outputTokens' | 'noCacheTokens' | 'cacheReadTokens' | 'cacheWriteTokens') =>
      (baseUsage?.[k] ?? 0) + (cur?.[k] ?? 0)
    const ctx = cur ?? baseUsage
    return {
      calls: sum('calls'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      noCacheTokens: sum('noCacheTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      cacheWriteTokens: sum('cacheWriteTokens'),
      lastInputTokens: ctx?.lastInputTokens ?? 0,
      breakdown: ctx?.breakdown ?? { system: 0, skills: 0, tools: 0, messages: 0, other: 0 },
      capacity: ctx?.capacity ?? { model: '', tokens: 0 },
    }
  }, [runUsage, baseUsage])
  /** 跨轮累计标记（含此前轮次 → 指示器显示「任务累计」） */
  const usageCrossRun = (baseUsage?.calls ?? 0) > 0

  /** 步骤进度（WS agent:step） */
  useEffect(() => {
    if (wsEvent?.type === 'agent:step') {
      setRunSteps({ step: wsEvent.step, total: wsEvent.total })
    }
  }, [wsEvent])



  /** 浏览器登录交接卡片：login-required 上屏，login-resolved 消失；ask_ai 超时对话框：ask-ai-waiting 上屏 */
  useEffect(() => {
    if (!wsEvent) return
    if (wsEvent.type === 'browser:login-required') {
      setLoginReq({ message: wsEvent.message })
    } else if (wsEvent.type === 'browser:login-resolved') {
      setLoginReq(null)
    } else if (wsEvent.type === 'browser:ask-ai-waiting') {
      // 网页 AI 卡住等拍板：音效提醒由下方 needsUserAct 上升沿统一触发（askAiWait 置位即响）
      setAskAiWait({ site: wsEvent.site, waitedSec: wsEvent.waitedSec })
    } else if (wsEvent.type === 'agent:status' && (wsEvent.phase === 'stopped' || wsEvent.phase === 'idle')) {
      // Agent 停止/结束：关闭超时对话框（任务已不等待）
      setAskAiWait(null)
    } else if (wsEvent.type === 'agent:usage') {
      // token 消耗快照 → 执行指示器 hover 面板（会话过滤：切会话后旧会话仍在跑的流不再驱动本面板）
      if (wsEvent.sessionId === sessionId) {
        runUsageRef.current = wsEvent
        setRunUsage(wsEvent)
      }
    } else if (wsEvent.type === 'gate:result') {
      // 转人工红牌（3 次不过）：需要用户介入处理，直接按事件触发音效（无持久状态可做边沿）
      if (wsEvent.report.stopped && !wsEvent.report.passed) playAlertSound()
      // 门禁通过且是章节文件 → 记录本轮交付（任务结束后出交付卡）
      if (wsEvent.report.passed && wsEvent.report.chapter != null) {
        setDelivery({ chapter: wsEvent.report.chapter, file: wsEvent.report.file })
      }
    } else if (wsEvent.type === 'tracking:updated') {
      // 追踪修订号 → 交付卡 rev 展示
      setDeliveryRev(wsEvent.revision)
    }
  }, [wsEvent, sessionId])

  /** 已撞单轮步数上限：步骤满额且本轮已停止 → 明确提醒「回复继续」 */
  const stepCapped = runSteps !== null && runSteps.step >= runSteps.total && !working

  /** 需要用户参与/拍板的全量信号（音效边沿触发）：
   *  审批停靠 / 问答·确认表单（最后一条 assistant 消息）/ Agent 文本提问待回复 /
   *  浏览器人工登录 / 网页 AI 超时拍板 / 步数上限需「继续」。门禁转人工走 WS 事件直触发（上方 effect）。 */
  const lastFormPending =
    lastAssistantMsg?.parts.some(
      (p) =>
        (p.type === 'tool-ask_questions' || p.type === 'tool-ask_confirm') &&
        (p as ToolPartLike).state !== 'output-available',
    ) ?? false
  const needsUserAct =
    pendingApprovalLeft > 0 ||
    lastFormPending ||
    awaiting ||
    loginReq !== null ||
    askAiWait !== null ||
    stepCapped
  /** 上升沿触发提醒音：信号从「无」变「有」时播放一次（审批逐个出现/表单弹出新轮各响一次）。
   *  挂载与切换会话只重置基线不响——历史消息里遗留的待答表单/提问不该在打开时响铃。 */
  const actRef = useRef(false)
  const actMountedRef = useRef(false)
  const actSessionRef = useRef(sessionId)
  useEffect(() => {
    if (!actMountedRef.current) {
      actMountedRef.current = true
      actRef.current = needsUserAct
      return
    }
    if (actSessionRef.current !== sessionId) {
      actSessionRef.current = sessionId
      actRef.current = needsUserAct
      return
    }
    if (needsUserAct && !actRef.current) playAlertSound()
    actRef.current = needsUserAct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsUserAct, sessionId])

  // ── 常驻桌宠信号收集（桌宠常驻升级实现方案 §4.4）──
  /** 工具执行启发式：最后一条 assistant 消息存在未完成 tool part（提交待执行/流式入参；审批态不算工具活动） */
  const toolActive = !!lastAssistantMsg?.parts.some(
    (p) => isToolPart(p) && (p.state === 'input-streaming' || p.state === 'input-available'),
  )
  /** Agent 向你提问：最后一条消息在等回复，或其内嵌问答/确认表单（只看最后一条，避免历史工具误报常驻） */
  const lastAskTool = !!lastAssistantMsg?.parts.some((p) => p.type === 'tool-ask_questions' || p.type === 'tool-ask_confirm')
  const livePet = usePetState(wsEvent, {
    routePhase,
    chatStatus: status,
    hasError: !!error || !!emptyReply,
    pendingApprovals: pendingApprovalLeft,
    loginReq: loginReq !== null,
    asking: awaiting || lastAskTool,
    stepCapped,
    toolActive,
    working,
    onDoneFinished: endRoute,
  })
  /** 桌宠调试器（#pet-debug 或 localStorage['pet-debug']='1' 开启）：强制任意状态，演示/回归不用真跑 Agent */
  const [petDebugOn] = useState(
    () => window.location.hash.includes('pet-debug') || localStorage.getItem('pet-debug') === '1',
  )
  const [petDebug, setPetDebug] = useState<PetState | null>(null)
  const petState = petDebug ?? livePet
  /** 上报给顶栏胶囊（ref 收敛回调依赖；petState/elapsed 变化才发，流式 chunk 不触发） */
  const onPetLiveRef = useRef(onPetLive)
  onPetLiveRef.current = onPetLive
  useEffect(() => {
    onPetLiveRef.current?.({ state: petState, elapsed })
  }, [petState, elapsed])
  /** 显示开关（设置中心「外观 · 桌宠」；默认显示，持久化跟随上一次选择） */
  const petPrefs = usePetPrefs()


  const modelList = models && models.length > 0 ? models : []
  const effortList = reasoningEfforts && reasoningEfforts.length > 0 ? reasoningEfforts : [{ id: 'max', label: '思考：极大（默认）' }]

  /** 执行指示器组装：状态短句 + 终态定格（lastRun 挂在具体消息上，消息列表里仍存在才显示——
   *  切会话自动消失；msgId=null（无 assistant 消息的失败轮）也显示 FAILED 终态；
   *  working 态任何模式均显示（submitted=等待响应，streaming 按 toolActive 区分） */
  const runStatus = working
    ? status === 'submitted'
      ? '等待响应'
      : toolActive
        ? '工具执行中'
        : '深度思考中'
    : lastRun?.outcome === 'error'
      ? '执行出错'
      : lastRun?.outcome === 'stopped'
        ? '已手动终止'
        : '执行完成'
  const runDone =
    lastRun !== null && (lastRun.msgId === null || messages.some((m) => m.id === lastRun.msgId))
      ? { seconds: lastRun.seconds, outcome: lastRun.outcome }
      : null

  /** 手动终止入口：先标记本轮结局为 stopped（指示器 STOPPED 终态 + 桌宠跳过 done 庆祝）再停流 */
  const stopRun = () => {
    runStoppedRef.current = true
    stop()
  }

  /** 当前动作（驾驶舱 NOW 行）：最后一条 assistant 消息里最后一个工具 part 的一行摘要。
   *  思考间隙保留上一动作（稳定显示，不闪断）；无任何工具调用时为 null（纯文本轮不显示该行） */
  let currentAction: string | null = null
  let currentToolName: string | null = null
  let currentToolInput: Record<string, unknown> | null = null
  if (working && lastAssistantMsg) {
    for (let i = lastAssistantMsg.parts.length - 1; i >= 0; i--) {
      const p = lastAssistantMsg.parts[i] as ToolPartLike | undefined
      if (
        p &&
        typeof p.type === 'string' &&
        p.type.startsWith('tool-') &&
        p.type !== 'tool-approval-request' &&
        p.type !== 'tool-approval-response'
      ) {
        currentAction = summarizeToolPart(p)
        currentToolName = p.type.replace(/^tool-/, '')
        currentToolInput = (p.input ?? {}) as Record<string, unknown>
        break
      }
    }
  }

  /** 执行时间线累积器（只增不减）：上游流式过程中消息可能被替换/裁剪，画布按 key 合并
   *  （用户消息 id / assistant 消息 id / toolCallId），已画节点永不回退；会话切换（首条消息 id 变化）才重置。 */
  const timelineAccRef = useRef<{ firstId: string; items: RunLiveItem[] }>({ firstId: '', items: [] })

  /** 运行实时快照（工作流画布点亮）：当前工具/动作/写作章号/本轮已见步骤/全会话执行时间线。
   *  章号从 Write/Edit 的 path「第NNN章」解析；seen 从最后一条 assistant 消息全部 tool parts 收集；
   *  timeline 正向合并全量消息——每条用户消息 = Start 节点、每条 assistant 消息 = 一步（思考 + 工具调用，事实链零猜测）；
   *  model 取 WS usage 快照的 capacity.model（运行时真实模型）。 */
  const runLive: RunLive = useMemo(() => {
    let chapter: number | null = null
    if (currentToolName === 'Write' || currentToolName === 'Edit') {
      const m = /第(\d{1,4})章/.exec(String(currentToolInput?.path ?? ''))
      if (m) chapter = Number(m[1])
    }
    const seen = new Set<string>()
    if (lastAssistantMsg) {
      for (const p of lastAssistantMsg.parts) {
        const t = (p as { type?: string }).type ?? ''
        if (typeof t !== 'string' || !t.startsWith('tool-')) continue
        const st = (p as ToolPartLike).state
        if (st === 'approval-requested' || st === 'approval-responded') continue
        const step = wfStepOfTool(t.replace(/^tool-/, ''))
        if (step) seen.add(step)
      }
    }
    // 时间线累积合并（幂等：重复合并同一消息结果不变）
    const acc = timelineAccRef.current
    const firstId = messages[0]?.id ?? ''
    if (acc.firstId !== firstId) {
      acc.firstId = firstId
      acc.items = []
    }
    let task: string | null = null
    for (const m of messages) {
      if (m.role === 'user') {
        const tp = m.parts.find((p) => p.type === 'text') as { text?: string } | undefined
        const text = tp?.text?.trim().slice(0, 80) ?? ''
        task = text || task
        if (text && !acc.items.some((it) => it.key === `u:${m.id}`)) {
          acc.items.push({ kind: 'start', key: `u:${m.id}`, task: text })
        }
        continue
      }
      if (m.role !== 'assistant') continue
      let reasoning: string | null = null
      const calls: RunLiveCall[] = []
      for (const p of m.parts) {
        if ((p as { type?: string }).type === 'reasoning') {
          const txt = ((p as { text?: string }).text ?? '').trim()
          if (txt) reasoning = ((reasoning ?? '') + ' ' + txt).trim()
          continue
        }
        const pp = p as ToolPartLike
        if (
          typeof pp.type !== 'string' ||
          !pp.type.startsWith('tool-') ||
          pp.type === 'tool-approval-request' ||
          pp.type === 'tool-approval-response' ||
          !pp.toolCallId
        ) continue
        if (pp.state === 'approval-requested' || pp.state === 'approval-responded') continue
        calls.push({
          id: pp.toolCallId,
          name: pp.type.replace(/^tool-/, ''),
          summary: summarizeToolPart(pp),
          state: pp.state === 'output-available' ? 'done' : pp.state === 'output-error' ? 'error' : 'running',
        })
      }
      if (!reasoning && calls.length === 0) continue
      if (reasoning) reasoning = reasoning.slice(0, 160)
      const key = `a:${m.id}`
      let item = acc.items.find((it) => it.key === key)
      if (!item || item.kind !== 'step') {
        item = { kind: 'step', key, reasoning, calls }
        acc.items.push(item)
      } else {
        if (reasoning) item.reasoning = reasoning
        for (const c of calls) {
          const i = item.calls.findIndex((x) => x.id === c.id)
          if (i >= 0) item.calls[i] = c
          else item.calls.push(c)
        }
      }
    }
    return {
      working,
      toolName: currentToolName,
      action: currentAction,
      chapter,
      seen: [...seen],
      timeline: acc.items,
      task,
      model: runUsage?.capacity.model ?? null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, working, currentToolName, currentAction, runUsage])
  const onRunLiveRef = useRef(onRunLive)
  /** 节流签名：只在工具调用增删/状态迁移/思考段落推进/动作变化时上浮，纯文本 chunk 不触发 App 级重渲染
   *  （思考文本按 80 字粒度进签名——思考内容实时生长但不逐 token 上浮） */
  const runLiveSigRef = useRef('')
  useEffect(() => {
    const sig =
      `${runLive.working}|${runLive.model}|${runLive.toolName}|${runLive.action}|${runLive.chapter}|` +
      runLive.timeline
        .map((it) =>
          it.kind === 'start'
            ? `s${it.key}`
            : `a${it.key}:${it.reasoning ? Math.floor(it.reasoning.length / 80) : 'n'}${it.calls
                .map((c) => `${c.id}:${c.state[0]}`)
                .join(',')}`,
        )
        .join('|')
    if (runLiveSigRef.current === sig) return
    runLiveSigRef.current = sig
    onRunLiveRef.current?.(runLive)
  }, [runLive])

  /** ask_ai 超时对话框：用户点选「继续 / 放弃」→ 回传 server（askAiBus），工具据此恢复
   *  继续：工具重置超时再等一轮；放弃：工具回退通道 A；300s 无人作答 → 工具自动终止。 */
  const answerAskAi = async (answer: 'continue' | 'abort') => {
    if (askAiSubmitting) return
    setAskAiSubmitting(true)
    await submitAskAiAnswer(answer)
    setAskAiWait(null)
    setAskAiSubmitting(false)
  }

  /** 单个 part 渲染（流式平铺与任务完成后的折叠布局共用同一实现）：思考块 / 文字 / 表单 / 审批卡 / 工具卡 */
  const renderPart = (m: UIMessage, part: UIMessage['parts'][number], i: number): React.ReactNode => {
    const busyFlags = working || pendingApprovals.length > 0
    // DeepSeek 思维链（reasoning part，provider 解析 reasoning_content）→ 可折叠「思考过程」
    if (part.type === 'reasoning' && 'text' in part) {
      const rt = Array.isArray(part.text) ? part.text.join('') : String(part.text ?? '')
      if (!rt) return null
      // key 必须加索引：DeepSeek provider 把每个 step 的 reasoning id 硬编码为
      // "reasoning-0"，多 step 消息里所有思考块 id 相同——单用 part.id 作 key 会
      // 全部撞车，React 同 key 调和异常 → 思考块疯狂重复渲染
      return (
        <ReasoningBlock
          key={`${part.id ?? 'reasoning'}-${i}`}
          text={rt}
          streaming={part.state === 'streaming'}
        />
      )
    }
    if (part.type === 'text' && 'text' in part && part.text) {
      return (
        <div
          key={i}
          className="msg-text msg-markdown"
          dangerouslySetInnerHTML={{ __html: md.render(part.text) }}
        />
      )
    }
    // ask_questions 工具 → 内嵌问答表单（不落 ToolCard）
    if (part.type === 'tool-ask_questions') {
      const qq = (part as ToolPartLike).input as { title?: string; questions?: string[] } | undefined
      if (Array.isArray(qq?.questions) && qq.questions.length > 0) {
        return (
          <QuestionForm
            key={part.toolCallId ?? i}
            title={qq.title ?? 'Agent 向你提问'}
            questions={qq.questions}
            busy={busyFlags}
            onSend={sendWithRoute}
          />
        )
      }
      return null
    }
    // ask_confirm 工具 → 单题确认表单（复用 QuestionForm，题目内含「已登录/取消」等选项说明）
    if (part.type === 'tool-ask_confirm') {
      const qc = (part as ToolPartLike).input as { title?: string; question?: string } | undefined
      if (qc?.question) {
        return (
          <QuestionForm
            key={part.toolCallId ?? i}
            title={qc.title ?? '需要你确认'}
            questions={[qc.question]}
            busy={busyFlags}
            onSend={sendWithRoute}
          />
        )
      }
      return null
    }
    if (part.type === 'step-start') return null
    if (isToolPart(part)) {
      const toolName = part.type.replace(/^tool-/, '')
      const toolInput = (part.input ?? {}) as Record<string, unknown>
      // 待决审批：审批卡代替工具卡（工具本身未执行，「执行中」是假状态）
      if (part.state === 'approval-requested' && part.approval?.id) {
        // 历史回合（早于最后一条 assistant 消息）的审批已过期：只读占位，不要求重复确认
        if (m !== lastAssistantMsg) {
          return (
            <div key={part.approval.id} className="msg-hist-approval">
              ⏸ 写入请求（{String((toolInput as { path?: string }).path ?? '')}）——先前回合已处理，无需再次确认
            </div>
          )
        }
        return (
          <ApprovalCard
            key={part.approval.id}
            name={toolName}
            input={toolInput}
            onDecide={(approved) =>
              addToolApprovalResponse({ id: part.approval!.id, approved })
            }
          />
        )
      }
      // 已响应（等待续跑执行/被拒绝）：显示已决定状态，执行后转 output 状态由工具卡接管
      if (part.state === 'approval-responded') {
        return (
          <ApprovalCard
            key={part.approval?.id ?? part.toolCallId}
            name={toolName}
            input={toolInput}
            decided={part.approval?.approved ?? null}
          />
        )
      }
      return <ToolCard key={part.toolCallId ?? i} part={part} />
    }
    return null
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">Story Studio</div>
            <div className="chat-empty-sub">
              与 Agent 讨论新书、写正文、跑质检、提交追踪——试着说「写第10章」或「聊聊剧情」。
            </div>
          </div>
        )}
        {messages.map((m) => {
          const busyFlags = working || pendingApprovals.length > 0
          /** 兜底表单：最后一条 assistant 消息文本启发式提取到问题且未走工具表单 */
          const showFallback = m === lastMsg && m.role === 'assistant' && qBlock !== null && !m.parts.some((p) => p.type === 'tool-ask_questions')
          /** 本条消息内的待决审批（多条时提供批量处理条）；历史消息不显示批量条 */
          const msgApprovals = m.parts.filter(isPendingApprovalPart)
          /** 实时流式中的最后一条消息：过程平铺实时可见（保持执行中的临场感） */
          const isLiveMsg = m === lastMsg && working
          /** 任务完成态的 assistant 消息（历史消息/本轮已结束/审批停靠）：过程折叠，只留最终文字 */
          const foldProcess = m.role === 'assistant' && !isLiveMsg
          /** 折叠布局下保留在外的最后一段非空文字（最终输出）的索引 */
          let lastTextIdx = -1
          if (foldProcess) {
            m.parts.forEach((p, idx) => {
              if (p.type === 'text' && 'text' in p && (p as { text: string }).text.trim()) lastTextIdx = idx
            })
          }
          return (
            <div key={m.id} className={`msg msg-${m.role}`}>
              <div className="msg-role">
                {m.role === 'user' ? '你' : <><Icon name="agent" size={26} raw /> Agent</>}
                {awaiting && m === lastMsg && m.role === 'assistant' && (
                  <span className="msg-tag-waiting"><Icon name="hourglass" size={12} /> 待回复</span>
                )}
              </div>
              <div className="msg-body">
                {foldProcess
                  ? (() => {
                      // 任务完成后的折叠布局：思考块/工具卡/中间文字收进 ProcessFold（可展开回看），
                      // 表单/审批卡/最终文字留在外面保持可见可操作。仅渲染层聚合，parts 数据不变。
                      const proc: React.ReactNode[] = []
                      const out: React.ReactNode[] = []
                      let toolN = 0
                      let reasonN = 0
                      let midN = 0
                      // 连续普通工具折叠为任务栏（历史/完成态收起为一行），遇其他 part 先冲刷
                      let run: ToolPartLike[] = []
                      const flushRun = () => {
                        if (run.length > 0) {
                          proc.push(<ToolCallsBar key={`tcb-${run[0]!.toolCallId ?? proc.length}`} parts={run} live={false} />)
                          run = []
                        }
                      }
                      m.parts.forEach((part, idx) => {
                        const t = (part as { type?: string }).type ?? ''
                        if (t === 'step-start') return
                        if (isBarToolPart(part)) {
                          toolN += 1
                          run.push(part)
                          return
                        }
                        flushRun()
                        if (t === 'reasoning') {
                          reasonN += 1
                          proc.push(renderPart(m, part, idx))
                          return
                        }
                        if (t === 'tool-ask_questions' || t === 'tool-ask_confirm') {
                          out.push(renderPart(m, part, idx))
                          return
                        }
                        if (t.startsWith('tool-')) {
                          const st = (part as ToolPartLike).state
                          // 最后一条消息的未决/已决审批卡保持在外可操作；历史审批占位收进折叠区
                          if (
                            (st === 'approval-requested' && m === lastAssistantMsg) ||
                            st === 'approval-responded'
                          ) {
                            out.push(renderPart(m, part, idx))
                          } else {
                            proc.push(renderPart(m, part, idx))
                          }
                          return
                        }
                        if (t === 'text') {
                          if (idx === lastTextIdx) {
                            out.push(renderPart(m, part, idx)) // 最终输出留在外面
                          } else if ('text' in part && String((part as { text?: unknown }).text ?? '').trim()) {
                            midN += 1
                            proc.push(renderPart(m, part, idx)) // 中间零散文字收进折叠区
                          }
                        }
                      })
                      flushRun()
                      // 交付卡：本轮有章节交付（门禁通过）且任务真正结束才出；出错轮不出（指示器 FAILED 已表达）
                      const showDelivery =
                        lastRun !== null && lastRun.msgId === m.id && delivery !== null && lastRun.outcome !== 'error'
                      return (
                        <>
                          <ProcessFold key={`fold-${m.id}`} tools={toolN} reasons={reasonN} mids={midN}>
                            {proc}
                          </ProcessFold>
                          {showDelivery && delivery && lastRun && (
                            <DeliveryCard
                              key="dlv"
                              chapter={delivery.chapter}
                              file={delivery.file}
                              outcome={lastRun.outcome}
                              seconds={lastRun.seconds}
                              usage={taskUsage}
                              rev={deliveryRev}
                              onJump={onJumpChapter}
                            />
                          )}
                          {out}
                        </>
                      )
                    })()
                  : collapseToolRuns(m.parts, isLiveMsg, (part, i) => renderPart(m, part, i))}
                {showFallback && qBlock && (
                  <QuestionForm
                    key="fallback"
                    title={qBlock.title}
                    questions={qBlock.questions}
                    busy={busyFlags}
                    onSend={sendWithRoute}
                  />
                )}
                {msgApprovals.length > 1 && m === lastAssistantMsg && (
                  <div className="ap-batch">
                    <span className="ap-batch-title">
                      共 {msgApprovals.length} 个写入请求——全部处理完 Agent 才会继续
                    </span>
                    <button
                      type="button"
                      className="btn-approve"
                      disabled={busyFlags}
                      onClick={() => respondBatch(true)}
                    >
                      <Icon name="check-circle" size={13} /> 全部允许
                    </button>
                    <button
                      type="button"
                      className="btn-deny"
                      disabled={busyFlags}
                      onClick={() => respondBatch(false)}
                    >
                      全部拒绝
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {working && routePhase === 'idle' && (
          <div className="chat-status">
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            {status === 'submitted' ? (
              <>
                <Icon name="hourglass" size={14} /> 已发送，等待 Agent 响应…（已耗时 {fmtDuration(elapsed)}）
              </>
            ) : (
              <>
                <Icon name="brain" size={14} /> 深度思考中…（已耗时 {fmtDuration(elapsed)}）
              </>
            )}
          </div>
        )}
        {error && <div className="chat-error">{error.message}</div>}
        {emptyReply && (
          <div className="chat-empty-reply">
            <Icon name="warning" size={14} />
            <span>{emptyReply}</span>
          </div>
        )}
        {loginReq && (
          <div className="chat-login-card">
            <Icon name="monitor" size={15} />
            <div className="chat-login-body">
              <div className="chat-login-title">⏸ 等待人工登录</div>
              <div className="chat-login-msg">{loginReq.message}</div>
              <div className="chat-login-sub">
                已切到「Agent浏览器」面板——请在画面里直接完成登录（密码/扫码/滑块，真实浏览器画面可直接操作）；完成后流程自动恢复
              </div>
            </div>
          </div>
        )}
        {askAiWait && (
          <div className="chat-login-card chat-askai-card">
            <Icon name="hourglass" size={15} />
            <div className="chat-login-body">
              <div className="chat-login-title">⏳ 网页 AI 仍在生成</div>
              <div className="chat-login-msg">
                已等待 {Math.round((askAiWait.waitedSec ?? 0) / 60)} 分钟仍未完成
                {askAiWait.site ? `（${askAiWait.site}）` : ''}，Agent 已暂停等待你的决定。
              </div>
              <div className="chat-login-sub">
                网页 AI 可能仍在思考（长章节会先列情节再写作）。选择「继续等待」则再过一轮；选择「放弃」则回退底层模型（通道 A）完成本次创作。若 300 秒内不作答，任务将自动终止。
              </div>
              <div className="chat-askai-actions">
                <button
                  type="button"
                  className="chat-askai-btn chat-askai-go"
                  disabled={askAiSubmitting}
                  onClick={() => void answerAskAi('continue')}
                >
                  继续等待
                </button>
                <button
                  type="button"
                  className="chat-askai-btn chat-askai-abort"
                  disabled={askAiSubmitting}
                  onClick={() => void answerAskAi('abort')}
                >
                  放弃，回退通道 A
                </button>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {canJump && (
        <button type="button" className="chat-jump" onClick={jumpToBottom}>
          ↓ 回到底部（已暂停自动跟随）
        </button>
      )}

      <GateStopCard wsEvent={wsEvent} status={status} />

      {pendingApprovalLeft > 0 && (
        <div className="ap-pending-bar">
          <span className="ap-pending-text">
            ⏸ 还有 {pendingApprovalLeft} 个写入请求未处理——全部处理完 Agent 才会继续
          </span>
          <div className="ap-pending-actions">
            {autoAllowAvailable && (
              <label
                className={`ap-autoallow${autoAllow ? ' on' : ''}`}
                title="开启后本会话的 Write/Edit 审批自动放行，无需逐个点击；浏览器等高危操作仍手动确认"
              >
                <input type="checkbox" checked={autoAllow} onChange={(e) => setAutoAllow(e.target.checked)} />
                {autoAllow ? '自动放行中' : '自动放行'}
              </label>
            )}
            <button
              type="button"
              className="btn-approve"
              disabled={status === 'streaming'}
              onClick={() =>
                pendingApprovals.forEach((p) =>
                  addToolApprovalResponse({ id: (p as ToolPartLike).approval!.id, approved: true }),
                )
              }
            >
              <Icon name="check-circle" size={13} /> 全部允许
            </button>
            <button
              type="button"
              className="btn-deny"
              disabled={status === 'streaming'}
              onClick={() =>
                pendingApprovals.forEach((p) =>
                  addToolApprovalResponse({ id: (p as ToolPartLike).approval!.id, approved: false }),
                )
              }
            >
              全部拒绝
            </button>
          </div>
        </div>
      )}

      {awaiting && !hasQTool && qBlock === null && (
        <div className="chat-awaiting"><Icon name="pen-line" size={14} /> Agent 正在等待你的回复 —— 直接在下方输入框回答</div>
      )}

      {stepCapped && (
        <div className="chat-cap-notice">
          <Icon name="warning" size={14} />
          <span>
            已到达单轮步数上限（{runSteps?.step}/{runSteps?.total}），任务未完成——直接回复「继续」接着做；已写入的文件与进度都保留，新的一轮会从这里续跑。
          </span>
        </div>
      )}

      {/* Agent 执行指示器（brutalist 混凝土面板）：执行中常驻（驾驶舱：当前动作 + 步骤进度）/ 完成定格；hover 展开本次任务 token 消耗（跨轮累计） */}
      <AgentRunIndicator
        working={working}
        statusLabel={runStatus}
        elapsed={elapsed}
        done={runDone}
        usage={taskUsage}
        crossRun={usageCrossRun}
        currentAction={currentAction}
        steps={runSteps}
      />

      {/* 完全允许开关已移入输入栏工具条（ChatComposer，模型切换旁）；状态与自动放行逻辑仍在此处 */}
      <div className="chat-input-row">
        {/* 桌宠调试器：点一个状态强制锁定，再点一次回到实时仲裁 */}
        {petDebugOn && (
          <div className="pet-debug">
            {PET_STATES.map((st) => (
              <button
                key={st}
                type="button"
                className={petDebug === st ? 'on' : ''}
                onClick={() => setPetDebug((cur) => (cur === st ? null : st))}
              >
                {st}
              </button>
            ))}
          </div>
        )}
        {/* 常驻桌宠：输入栏右上肩，12 态仲裁（usePetState），执行类状态正下方挂计时牌；设置中心可隐藏 */}
        {!petPrefs.hidden && (
          <PetMascot
            state={petState}
            phase={routePhase === 'idle' ? null : routePhase}
            agentElapsed={elapsed}
            onFocusInput={() => {
              // 聚焦输入框：Composer 未暴露 ref，直接定位其 textarea（.prompt-input 内唯一）
              document.querySelector<HTMLTextAreaElement>('.prompt-input textarea')?.focus()
            }}
            onScrollBottom={jumpToBottom}
          />
        )}
        <ChatComposer
          busy={working || pendingApprovals.length > 0}
          sending={routePhase !== 'idle'}
          models={modelList}
          activeModelId={activeModelId}
          insertFile={composerInsert}
          efforts={effortList}
          workspace={workspace}
          onModelChange={(m) => {
            modelRef.current = m
          }}
          onEffortChange={(e) => {
            effortRef.current = e
          }}
          autoAllow={autoAllowAvailable ? autoAllow : undefined}
          onToggleAutoAllow={autoAllowAvailable ? () => setAutoAllow((v) => !v) : undefined}
          onSend={sendWithRoute}
          onStop={stopRun}
        />
      </div>
    </div>
  )
}

/** 任务过程折叠容器：一轮任务完成后把过程（思考块+工具卡+中间文字）整体收起，只留最终输出。
 *  流式期间不渲染本组件（保持过程平铺实时可见），挂载即收起态；用户点头部可展开回看全过程。
 *  纯渲染层聚合：UIMessage.parts 数据原样不变（历史/持久化/模型上下文均不受影响）。 */
function ProcessFold({
  tools,
  reasons,
  mids,
  children,
}: {
  tools: number
  reasons: number
  mids: number
  children: React.ReactNode
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (tools === 0 && reasons === 0 && mids === 0) return null // 纯文字消息无过程，不渲染折叠头
  return (
    <div className={`process-fold${open ? ' open' : ''}`}>
      <button type="button" className="process-fold-head" onClick={() => setOpen((v) => !v)}>
        <span className="process-fold-title">
          <Icon name="clipboard-list" size={13} /> 任务执行过程
        </span>
        <span className="process-fold-meta">
          {tools} 次工具 · {reasons} 段思考{mids > 0 ? ` · ${mids} 段说明` : ''}
        </span>
        <span className="process-fold-toggle">{open ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {open && <div className="process-fold-body">{children}</div>}
    </div>
  )
}

/** token 数 → K/M 简写（交付卡紧凑展示） */
function fmtTokensK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 交付卡：章节交付的结构化收尾（章节标题/字数/门禁/追踪/耗时/token + 去阅读按钮）。
 *  朱印三态：完=玉青（成功交付）/ 止=琥珀（交付后任务被手动终止）；出错轮不出卡（指示器 FAILED 已表达）。
 *  字数为异步估算（拉取章节文件统计非空白字符），读取失败显示 —。 */
function DeliveryCard({
  chapter,
  file,
  outcome,
  seconds,
  usage,
  rev,
  onJump,
}: {
  chapter: number
  file: string
  outcome: RunOutcome
  seconds: number
  usage: RunUsageSnapshot | null
  rev: number | null
  onJump?: (chapter: number) => void
}): React.JSX.Element {
  const [chars, setChars] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchWorkspaceFile(file)
      .then((c) => {
        if (!cancelled && c) setChars(c.replace(/\s/g, '').length)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])
  const fname = file.split(/[\\/]/).pop() ?? file
  const title = /^第\d+章[_\- ]*(.*?)\.md$/.exec(fname)?.[1]?.trim() || fname
  const stopped = outcome === 'stopped'
  return (
    <div className={`dlv-card${stopped ? ' stopped' : ''}`}>
      <div className="dlv-stamp" aria-hidden>
        <i>{stopped ? '止' : '完'}</i>
      </div>
      <div className="dlv-body">
        <div className="dlv-title">
          第 {chapter} 章 · {title} {stopped ? '（已交付，任务随后被终止）' : '已交付'}
        </div>
        <div className="dlv-meta">
          <span className="dlv-kv">
            字数 <b>{chars !== null ? chars.toLocaleString() : '…'}</b>
          </span>
          <span className="dlv-kv pass">
            门禁 <b>PASS</b>
          </span>
          {rev !== null && (
            <span className="dlv-kv">
              追踪 <b>rev {rev}</b>
            </span>
          )}
          <span className="dlv-kv">
            耗时 <b>{fmtDuration(seconds)}</b>
          </span>
          {usage && usage.calls > 0 && (
            <span className="dlv-kv">
              token <b>{fmtTokensK(usage.inputTokens + usage.outputTokens)}</b>
            </span>
          )}
        </div>
        {onJump && (
          <div className="dlv-actions">
            <button type="button" className="dlv-btn" onClick={() => onJump(chapter)}>
              <Icon name="book-open" size={12} /> 去阅读本章
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** DeepSeek 思维链展示：流式中默认展开实时更新；本轮思考结束自动折叠（历史会话载入即折叠） */
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(Boolean(streaming))
  const wasStreamingRef = useRef(Boolean(streaming))
  useEffect(() => {
    const was = wasStreamingRef.current
    wasStreamingRef.current = Boolean(streaming)
    if (!was && streaming) setOpen(true) // 新一轮思考开始 → 展开
    else if (was && !streaming) setOpen(false) // 本轮思考结束 → 自动折叠（用户仍可手动展开）
  }, [streaming])
  return (
    <div className={`reasoning${open ? ' open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <span className="reasoning-title">
          {streaming ? <><Icon name="brain" size={13} /> 深度思考中…</> : <><Icon name="brain" size={13} /> 思考过程</>}（{text.length} 字）
        </span>
        <span className="reasoning-toggle">{open ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

/** 审批停靠卡片：允许/拒绝后流自动续跑。改写既有文件时展示词级 diff（M3）。
 *  decided：外部传入的已决状态（part.state=approval-responded 时由消息状态驱动） */
function ApprovalCard({
  name,
  input,
  decided: decidedProp,
  onDecide,
}: {
  name: string
  input: Record<string, unknown>
  decided?: boolean | null
  onDecide?: (approved: boolean) => void
}): React.JSX.Element {
  const [localDecided, setLocalDecided] = useState<boolean | null>(null)
  const decided = decidedProp ?? localDecided
  const decide = (approved: boolean) => {
    if (decided !== null || !onDecide) return
    setLocalDecided(approved)
    onDecide(approved)
  }
  const content = typeof input.content === 'string' ? input.content : ''
  const oldString = typeof input.old_string === 'string' ? input.old_string : ''
  const newString = typeof input.new_string === 'string' ? input.new_string : ''
  const path = typeof input.path === 'string' ? input.path : ''

  // Write：拉取磁盘当前内容 → 有旧内容则出 diff（新文件出预览）；Edit：直接 old→new
  const [disk, setDisk] = useState<string | null>(null)
  useEffect(() => {
    if (!path || typeof input.content !== 'string') return
    let cancelled = false
    fetchWorkspaceFile(path).then((c) => {
      if (!cancelled) setDisk(c)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div className={`approval-card${decided !== null ? ' decided' : ''}`}>
      <div className="ap-head">
        <span className="ap-icon">⏸</span>
        <span>
          请求确认：<b>{name}</b> → <code>{path}</code>
        </span>
      </div>
      {name === 'Edit' && oldString ? (
        <div className="ap-diff">
          <div className="ap-diff-title">替换片段（红=删除 绿=新增）</div>
          <DiffView oldText={oldString} newText={newString} maxHeight={260} />
        </div>
      ) : disk !== null ? (
        <div className="ap-diff">
          <div className="ap-diff-title">与当前文件的差异（红=删除 绿=新增）</div>
          <DiffView oldText={disk} newText={content} maxHeight={300} />
        </div>
      ) : disk === null && content ? (
        <pre className="ap-preview">
          {content.slice(0, 400)}
          {content.length > 400 ? `\n…（共 ${content.length} 字符）` : ''}
        </pre>
      ) : null}
      <div className="ap-actions">
        {decided !== null ? (
          <span className={`ap-decided ${decided ? 'approve' : 'deny'}`}>
            {decided ? '✓ 已允许执行' : '✕ 已拒绝'}
          </span>
        ) : (
          <>
            <button type="button" className="btn-approve" onClick={() => decide(true)}>
              ✓ 允许执行
            </button>
            <button type="button" className="btn-deny" onClick={() => decide(false)}>
              ✕ 拒绝
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 门禁停靠点卡片。
 * 黄牌（Agent 修复中）：纯提示，不提供回滚（此时回滚会覆盖修到一半的文件）；✕ 关闭后同文件后续重试不再打扰。
 * 红牌（转人工/已停止）：提供回滚（二次确认防误点），引导回滚后重写；该文件门禁通过后自动消除。 */
function GateStopCard({ wsEvent, status }: { wsEvent?: WsEvent | null; status: string }): React.JSX.Element | null {
  const [report, setReport] = useState<GateReport | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState('')

  useEffect(() => {
    if (wsEvent?.type !== 'gate:result') return
    const r = wsEvent.report
    if (!r.passed) {
      setReport(r)
      setOpen(false)
      setResult('')
      // 转人工/停止（红牌）必须重新展示：清除用户此前对该文件的忽略
      if (r.stopped) setDismissed(null)
    } else {
      // 该文件门禁通过 → 失败卡片使命完成，自动消除
      setReport((cur) => (cur && cur.file === r.file ? null : cur))
      setDismissed(null)
    }
  }, [wsEvent])

  if (!report) return null
  // Agent 正在重试中且未转人工 → 黄牌；stopped 或 Agent 已停 → 红牌
  const hard = report.stopped || status !== 'streaming'
  // 黄牌按「文件」记忆关闭（跨重试持续有效）；红牌按「文件@尝试次数」记忆（可重新出现）
  const dismissKey = hard ? `${report.file}@${report.attempts}` : report.file
  if (dismissed === dismissKey) return null

  const doRollback = async () => {
    // 二次确认：第一次点击仅进入确认态（3 秒无操作自动复位），防止误触覆盖当前稿
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }
    setConfirming(false)
    setBusy(true)
    setResult('')
    try {
      const snaps = await fetchHistory(report.file)
      const latest = snaps[0]
      if (!latest) {
        setResult('没有可回滚的快照')
      } else {
        await rollbackSnapshot(report.file, latest.snapshot)
        setResult(`已回滚到快照 ${latest.snapshot}（回滚前的版本也已另存快照，可再回滚）`)
      }
    } catch (e) {
      setResult(`回滚失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`gate-stop ${hard ? 'hard' : 'soft'}`}>
      <div className="gs-head">
        <span className="gs-icon">
          <Icon name={hard ? 'stop-shield' : 'warning'} size={16} className={hard ? 'gs-ico-hard' : 'gs-ico-soft'} />
        </span>
        <span className="gs-title">
          {hard ? '门禁未过 · 已转人工' : '门禁修复中'}：{report.file}
          {report.chapter != null ? `（第${report.chapter}章）` : ''} · 第 {report.attempts} 次尝试
        </span>
        <button
          type="button"
          className="gs-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '查看报告'}
        </button>
        <button
          type="button"
          className="gs-dismiss"
          title="关闭此提示"
          onClick={() => setDismissed(dismissKey)}
        >
          ✕
        </button>
      </div>
      {open && (
        <div className="gs-report">
          {report.scripts
            .filter((s) => s.exitCode !== 0)
            .map((s) => (
              <div key={s.name} className="gs-script">
                <div className="gs-script-name">
                  {s.name} · exit {s.exitCode}
                </div>
                <pre>{s.output}</pre>
              </div>
            ))}
          {report.scripts.every((s) => s.exitCode === 0) && (
            <div className="gs-script">（报告详情缺失）</div>
          )}
        </div>
      )}
      <div className="gs-actions">
        {hard && (
          <button type="button" className="btn-rollback" onClick={() => void doRollback()} disabled={busy}>
            {busy ? (
              '回滚中…'
            ) : confirming ? (
              <>
                <Icon name="warning" size={13} /> 再点一次确认回滚
              </>
            ) : (
              <>↩ 回滚最近快照</>
            )}
          </button>
        )}
        <span className="gs-hint">
          {hard
            ? 'Agent 已达重试上限或已停止。可「回滚最近快照」回到写入前版本，再发「已回滚，请重写本章」让 AI 重写；该文件门禁通过后本卡自动消失。'
            : 'Agent 正在自我修复，无需操作；若持续失败会转人工（红牌）并给出处理选项。'}
        </span>
      </div>
      {result && <div className="gs-result">{result}</div>}
    </div>
  )
}

/**
 * 问答表单：Agent 提问时逐题作答。
 * 上方显示问题全文，下方小输入栏；「下一个」推进（留空 = 跳过此题），
 * 题型答完进入汇总，一键把全部答案拼成一条消息发送给 Agent。
 */
function QuestionForm({
  title,
  questions,
  busy,
  onSend,
}: {
  title: string
  questions: string[]
  busy: boolean
  onSend: (text: string) => void
}): React.JSX.Element | null {
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''))
  const [phase, setPhase] = useState<'q' | 'sum'>('q')
  const [dismissed, setDismissed] = useState(false)
  /** 题号 ref：避免 onChange 闭包拿到旧 idx（切题后仍写入上一题） */
  const idxRef = useRef(0)
  idxRef.current = idx
  const inputRef = useRef<HTMLTextAreaElement>(null)

  if (dismissed) return null

  const answeredCount = answers.filter((a) => a.trim()).length
  const current = answers[idx] ?? ''

  /** 输入栏自动增高：内容多时撑开（上限后内滚），补充长内容时全程可见 */
  const autoGrow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`
  }
  // 切题时按已存答案恢复高度
  useEffect(() => {
    autoGrow(inputRef.current)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [idx])

  const save = (v: string) => {
    const i = idxRef.current
    setAnswers((prev) => prev.map((a, n) => (n === i ? v : a)))
  }
  const goNext = () => {
    if (idx < questions.length - 1) {
      setIdx(idx + 1) // 聚焦与高度恢复由 [idx] useEffect 处理
    } else {
      setPhase('sum')
    }
  }
  const prev = () => setIdx(Math.max(0, idx - 1))

  /** 汇总提交：每个问题一行，未答的标「（跳过）」 */
  const commit = () => {
    const lines = questions.map((q, i) => `${i + 1}. ${answers[i]?.trim() || '（跳过）'}`)
    onSend(`我来回答你提出的问题（${answeredCount}/${questions.length}）：\n${lines.join('\n')}`)
  }

  if (phase === 'sum') {
    return (
      <div className="qform">
        <div className="qform-head">
          <span className="qform-title">{title}</span>
          <span className="qform-count">答题完成 · 已答 {answeredCount}/{questions.length}（未答 0 = 跳过）</span>
          <button type="button" className="qform-close" title="关闭表单" onClick={() => setDismissed(true)}>
            ✕
          </button>
        </div>
        <div className="qform-sum">
          {questions.map((q, i) => (
            <div key={i} className="qform-sum-row">
              <span className="qform-sum-q">
                {i + 1}. {q.slice(0, 50)}
                {q.length > 50 ? '…' : ''}
              </span>
              <span className={`qform-sum-a${answers[i]?.trim() ? '' : ' skip'}`}>
                {answers[i]?.trim() || '已跳过'}
              </span>
            </div>
          ))}
        </div>
        <div className="qform-nav">
          <button type="button" className="btn-ghost" onClick={() => setPhase('q')}>
            ← 返回修改
          </button>
          {/* 胶囊主按钮：btn-send 是 36px 圆钮（为箭头图标设计），塞文字会溢出变形 */}
          <button type="button" className="qform-send" onClick={commit} disabled={busy}>
            {busy ? '发送中…' : `发送答案（${answeredCount}）`}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="qform">
      <div className="qform-head">
        <span className="qform-title">{title}</span>
        <span className="qform-count">
          第 {idx + 1}/{questions.length} 题 · 已答 {answeredCount}
        </span>
        <button type="button" className="qform-close" title="关闭表单" onClick={() => setDismissed(true)}>
          ✕
        </button>
      </div>
      <div
        className="qform-question"
        dangerouslySetInnerHTML={{ __html: md.render(questions[idx] ?? '') }}
      />
      <textarea
        // key=idx：每题一个独立 DOM 节点 + 非受控（defaultValue）。受控 textarea 在中文输入法
        // 组合期会被每次 onChange 触发的重渲染重写 value，导致「这题打不上字」（尤其是
        // 下一个按钮聚焦切换时更明显）；非受控后 DOM 里的拼音/汉字由浏览器自己维护，IME 安全。
        key={idx}
        ref={inputRef}
        className="qform-input"
        rows={2}
        defaultValue={current}
        onChange={(e) => {
          save(e.target.value)
          autoGrow(e.target)
        }}
        onKeyDown={(e) => {
          // 仅纯 Enter 下一题；Shift/Ctrl/Cmd+Enter 走默认换行（textarea 可多行，长补充内容全程可见）
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault()
            goNext()
          }
        }}
        placeholder="你的回答（留空则跳过此题，直接进入下一题；内容多时输入框会自动变高）"
        spellCheck={false}
        autoComplete="off"
      />
      <div className="qform-nav">
        <button type="button" className="btn-ghost" disabled={idx === 0} onClick={prev}>
          ← 上一个
        </button>
        <button type="button" className="btn-ghost" onClick={goNext}>
          {idx < questions.length - 1 ? '下一个 →' : '完成 →'}
        </button>
      </div>
    </div>
  )
}
