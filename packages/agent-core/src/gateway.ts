/**
 * opencode 网关（Console Go / Zen，https://opencode.ai/zen/go/v1）请求头注入。
 *
 * 背景：该网关 2026 起强制要求（opencode.ai/docs/go）：
 * ① 每个请求携带稳定的会话级 `x-opencode-session`——缺失直接报
 *   AI_APICallError「Request is missing x-opencode-session and cannot be routed efficiently」；
 * ② 自定义 User-Agent（如 story-studio-agent/1.0）而非通用 SDK/HTTP 库名（反滥用监测）。
 * 仅对 opencode 域名的 baseURL 注入，其他网关/官方端点返回 undefined（完全无感）。
 */
import { randomUUID } from 'node:crypto'

/** 识别 opencode 网关主机（opencode.ai 主域） */
export function isOpencodeGateway(baseUrl: string): boolean {
  try {
    return /(^|\.)opencode\.ai$/i.test(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

export const AGENT_USER_AGENT = 'story-studio-agent/1.0'

/**
 * 构建 opencode 网关请求头。
 * @param baseUrl    模型端点
 * @param sessionId  会话级稳定 id（同一对话的所有请求保持一致 → 路由/提示词缓存友好）；
 *                   缺省生成一次性随机 id（单发调用如路由兜底分类用）
 */
export function opencodeGatewayHeaders(baseUrl: string, sessionId?: string): Record<string, string> | undefined {
  if (!isOpencodeGateway(baseUrl)) return undefined
  return {
    'x-opencode-session': sessionId?.trim() ? sessionId.trim() : `agent-${randomUUID()}`,
    'user-agent': AGENT_USER_AGENT,
  }
}
