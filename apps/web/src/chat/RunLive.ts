/**
 * Agent 运行实时快照（ChatPanel → App → WorkPanel/WorkflowPanel）：
 * 与执行指示器「驾驶舱」同源的数据上浮——工作流视图据此点亮流程框。
 */
/** 本轮单个工具调用快照（执行画布节点源，按出现顺序排列） */
export interface RunLiveCall {
  /** toolCallId（React Flow 节点 id） */
  id: string
  /** 工具名（Read / Write / Bash …） */
  name: string
  /** 参数一行摘要（工具名 · 摘要） */
  summary: string
  /** running=已发起未返回；done=成功返回；error=出错 */
  state: 'running' | 'done' | 'error'
}

/**
 * 会话执行时间线条目（只增不减的累积器产出，执行画布节点源）：
 * - start = 用户指令（每条用户消息一个）
 * - step  = 一条 assistant 消息（思考正文 + 本步按序工具调用）
 */
export type RunLiveItem =
  | { kind: 'start'; key: string; task: string }
  | { kind: 'step'; key: string; reasoning: string | null; calls: RunLiveCall[] }

export interface RunLive {
  /** Agent 是否执行中（submitted/streaming） */
  working: boolean
  /** 当前工具名（null=思考中/无工具；思考间隙保留上一个工具名） */
  toolName: string | null
  /** 当前动作一行摘要（工具名 · 参数摘要） */
  action: string | null
  /** 正在写的章号（从 Write/Edit 的 path 解析；null=非写作工具） */
  chapter: number | null
  /** 本轮已出现过的步骤 id（prep/draft/write/gate/track；从消息 tool parts 收集） */
  seen: string[]
  /** 全会话执行时间线（只增不减：上游消息流被替换/裁剪也不丢已画节点，会话切换才重置） */
  timeline: RunLiveItem[]
  /** 最近一轮用户指令文本 */
  task: string | null
  /** 运行时真实模型（WS agent:usage 快照 capacity.model；Start 节点徽章） */
  model: string | null
}
