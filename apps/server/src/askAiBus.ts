/**
 * ask_ai 超时「继续/放弃」单槽应答总线（请求-响应模式）：
 * - ask_ai 工具达到 maxWaitMs 后调用 waitAskAiAnswer() 挂起（内部 300s 超时）
 * - 同时经 WS 事件 browser:ask-ai-waiting 弹前端对话框，用户点「继续/放弃」→ POST /api/browser/ask-ai-answer 写入
 * - 同一时刻只有一个 ask_ai 在跑（单站串行），单槽即可；重复提交覆盖/丢弃由调用方感知返回 false
 */
export type AskAiChoice = 'continue' | 'abort'

const ANSWER_TIMEOUT_MS = 300_000

let resolver: ((choice: AskAiChoice | 'timeout') => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** 挂起等待用户选择；返回 'continue' | 'abort' | 'timeout'（300s 无响应） */
export function waitAskAiAnswer(): Promise<AskAiChoice | 'timeout'> {
  return new Promise((resolve) => {
    resolver = resolve
    timer = setTimeout(() => {
      const r = resolver
      resolver = null
      timer = null
      r?.('timeout')
    }, ANSWER_TIMEOUT_MS)
  })
}

/** 前端 POST 写入选择；返回是否消费成功（无挂起等待时 false） */
export function submitAskAiAnswer(choice: AskAiChoice): boolean {
  if (!resolver) return false
  if (timer) clearTimeout(timer)
  const r = resolver
  resolver = null
  timer = null
  r(choice)
  return true
}