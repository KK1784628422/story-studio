/**
 * OpenAI 兼容网关 SSE/JSON 响应规范化中间件（自定义 fetch）。
 *
 * 背景：部分网关（实测 SenseNova token.sensenova.cn 的 deepseek-v4-pro）流式返回
 * tool_calls 分片时 `type` 为空串（协议要求 `"function"`）、`finish_reason` 为空串
 * （协议要求 null 或枚举值）→ Vercel AI SDK 严格 zod 校验抛 AI_TypeValidationError
 * 整轮流中断。业界通行做法是在 SDK 消费流之前拦截修正（不改 SDK 源码）。
 *
 * 另修一处 usage 字段差异：@ai-sdk/deepseek 只解析 DeepSeek 官方私有字段
 * `prompt_cache_hit_tokens`，而 OpenAI 兼容网关（如 opencode zen）普遍返回 OpenAI
 * 标准的 `prompt_tokens_details.cached_tokens` → 缓存实际命中（并按缓存价计费），
 * SDK 的 usage.inputTokenDetails.cacheReadTokens 却恒为 0。此处把标准字段值补写进
 * 官方私有字段名，SDK 原生解析路径即可拿到真实命中量；DeepSeek 官方直连时私有字段
 * 本就存在，映射自动跳过（幂等）。
 *
 * 行为汇总：①空 type → function；②空 finish_reason → null；③cached_tokens →
 * prompt_cache_hit_tokens。合规网关/官方 API 的响应无待修正项，中间件完全无感。
 * 另在扫到 finish_reason=length 时打 WARN（输出上限截断诊断，见 normalizeStreamChunk）。
 */
import { chatLog } from './log.ts'
/** 修正单个响应体里的 usage 字段（就地）；返回是否有改动 */
export function normalizeUsageFields(obj: unknown): boolean {
  const o = obj as {
    usage?: {
      prompt_cache_hit_tokens?: unknown
      prompt_tokens_details?: { cached_tokens?: unknown } | null
    } | null
  }
  const u = o?.usage
  if (!u || typeof u !== 'object') return false
  if (u.prompt_cache_hit_tokens != null) return false // 官方私有字段已在：无需映射
  const cached = u.prompt_tokens_details?.cached_tokens
  if (typeof cached !== 'number' || !Number.isFinite(cached)) return false
  u.prompt_cache_hit_tokens = cached
  return true
}

/** 修正单个 SSE JSON 对象（就地）；返回是否有改动 */
export function normalizeStreamChunk(obj: unknown): boolean {
  const usageChanged = normalizeUsageFields(obj)
  const o = obj as {
    choices?: Array<{
      finish_reason?: unknown
      delta?: { tool_calls?: Array<{ type?: unknown }> }
    }>
  }
  if (!o || !Array.isArray(o.choices)) return usageChanged
  let changed = false
  for (const ch of o.choices) {
    if (!ch || typeof ch !== 'object') continue
    const tcs = ch.delta?.tool_calls
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        if (tc && (tc.type === '' || tc.type == null)) {
          tc.type = 'function'
          changed = true
        }
      }
    }
    if (ch.finish_reason === '') {
      ch.finish_reason = null
      changed = true
    }
    // 截断诊断：length = 输出 token 上限耗尽（推理模型思考计入预算——表现为
    // 只留思考、无正文无工具调用，任务无声暂停）。只出现在流末尾 chunk，打点即可。
    if (ch.finish_reason === 'length') {
      chatLog('warn', '[stream] finish_reason=length：输出 token 上限耗尽（思考占满预算），本轮内容被截断')
    }
  }
  return changed || usageChanged
}

/** 修正一个 SSE 事件块（可能含多行 data:）；非 JSON / [DONE] 原样返回 */
function normalizeEventBlock(block: string): string {
  const lines = block.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      if (normalizeStreamChunk(obj)) {
        lines[i] = `data: ${JSON.stringify(obj)}`
        changed = true
      }
    } catch {
      /* 非 JSON data 行：原样 */
    }
  }
  return changed ? lines.join('\n') : block
}

/** 包装 SSE 响应流：按事件边界（\n\n）切块修正后重新吐出；跨 chunk 的半截事件缓冲 */
export function normalizeSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ''
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true })
        let idx: number
        let out = ''
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          out += normalizeEventBlock(buf.slice(0, idx + 2))
          buf = buf.slice(idx + 2)
        }
        if (out) controller.enqueue(enc.encode(out))
      },
      flush(controller) {
        buf += dec.decode()
        if (buf) {
          const fixed = normalizeEventBlock(buf)
          // 尾块可能无 \n\n 结尾（流被截断的兜底），保持原样补齐
          controller.enqueue(enc.encode(fixed.endsWith('\n\n') || fixed === '' ? fixed : `${fixed}\n\n`))
        }
      },
    }),
  )
}

/** 重建一个同状态的 Response（body 已按需修正）；调用方已持有原始 body 文本时使用 */
function rebuildResponse(res: Response, body: string, headers?: Headers): Response {
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: headers ?? res.headers,
  })
}

/**
 * 规范化 fetch：透传请求，对 2xx 响应做最小修正——
 * 流式（event-stream/ndjson）走 SSE 分片修正；非流式 JSON 仅映射 usage 缓存字段
 * （报文变化时移除 content-length 以免长度失配）。传给 createDeepSeek({ fetch })，
 * 对所有 OpenAI 兼容网关与官方 API 安全无感。
 */
export const normalizingFetch: typeof globalThis.fetch = async (input, init) => {
  const res = await globalThis.fetch(input as RequestInfo, init as RequestInit)
  if (!res.body || res.status >= 400) return res
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('event-stream') || ct.includes('ndjson')) {
    return new Response(normalizeSseStream(res.body), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
  if (ct.includes('json')) {
    const text = await res.text()
    try {
      const obj = JSON.parse(text) as unknown
      if (!normalizeUsageFields(obj)) return rebuildResponse(res, text)
      const headers = new Headers(res.headers)
      headers.delete('content-length')
      return rebuildResponse(res, JSON.stringify(obj), headers)
    } catch {
      return rebuildResponse(res, text) // 非 JSON 报文：原样透传
    }
  }
  return res
}
