/**
 * agent-core 日志钩子：server 启动时注入（写文件 + 推前端 WS）；缺省仅 console。
 * 与 server/log.ts 的 chatLog 解耦，避免 agent-core 依赖 server。
 */
export type LogLevel = 'info' | 'warn' | 'error'

let sink: ((level: LogLevel, msg: string) => void) | null = null

export function setChatLogger(fn: (level: LogLevel, msg: string) => void): void {
  sink = fn
}

export function chatLog(level: LogLevel, msg: string): void {
  if (sink) sink(level, msg)
  else console.log(`[chat] [${level.toUpperCase()}] ${msg}`)
}