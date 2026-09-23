/**
 * 免费池 key 故障转移 fetch（模型调用层）。
 *
 * 背景：日日新等免费端点（同 baseURL + 多账号 key）高峰期高频 429「使用的人数太多」。
 * 这类限流发生在 HTTP 响应阶段（流尚未开始），SDK 一次网络往返即可判定——
 * 因此在自定义 fetch 层做「换 key 轮询重试」即可，无需依赖 SDK 内部模型重建/中间件机制。
 * 模型构造照旧 createDeepSeek({ baseURL, fetch: 本工厂产物 })，SDK 视角只有一次调用，
 * 最终成功或全部 key 轮询耗尽才返回——对话流程全程不中断。
 *
 * 轮询策略：
 *  - 有序 key 池，恒尝试池首 key：成功直接返回（该 key 已是最优）；限流（429/503）则
 *    头尾轮换——下一个 key 顶到池首，下下次调用自然轮到不同账号，天然 round-robin；
 *  - 一轮整池全限流（服务端整体过载）→ 短暂等待后整池第二轮延长机会，最大 maxRounds
 *    轮（默认 2）；仍失败才返回最后一个限流响应（SDK 转 APICallError →
 *    describeModelError 免费池文案明确归因，非 Agent 故障）；
 *  - 每次换 key 打日志（chatLog），可排查哪些账号在限流。
 */
import { chatLog } from './log.ts'

export interface FailoverFetchOptions {
  /** key 池（≥2 才有故障转移意义；≤10 由配置层保证） */
  keys: string[]
  /** 底层 fetch（默认 globalThis.fetch）；外部可传 normalizingFetch 叠加网关规范化 */
  fetchImpl?: typeof globalThis.fetch
  /** 日志标签（如模型 ID），便于区分是哪次调用在轮询 */
  label?: string
  /** 相邻换 key 间隔（ms）：免费端点限流判定快，稍作喘息避免连击；默认 300 */
  retryDelayMs?: number
  /** 整池一轮全 429 后的轮间等待（ms）；默认 1500 */
  roundDelayMs?: number
  /** 整池轮询最大轮数；默认 2（一轮换遍 + 喘息后补一轮） */
  maxRounds?: number
}

/** 限流状态码：429 太忙/配额耗尽；503 服务过载（免费端点常见等价信号） */
const THROTTLED_STATUS = new Set([429, 503])
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createFailoverFetch(opts: FailoverFetchOptions): typeof globalThis.fetch {
  const { keys, fetchImpl = globalThis.fetch, label = 'model' } = opts
  const retryDelayMs = opts.retryDelayMs ?? 300
  const roundDelayMs = opts.roundDelayMs ?? 1500
  const maxRounds = Math.max(1, opts.maxRounds ?? 2)
  // 有序 key 池（去重去空），跨调用持久：恒尝试池首，成功即停、限流则头尾轮换
  const order: string[] = [...new Set(keys.filter((k) => typeof k === 'string' && k.trim() !== ''))]

  return async (input, init) => {
    const headers = new Headers(init?.headers ?? {})
    let lastRes: Response | null = null
    let round = 0
    while (round < maxRounds && order.length > 0) {
      const tries = order.length
      for (let i = 0; i < tries; i++) {
        const key = order[0]!
        headers.set('authorization', `Bearer ${key}`)
        const res = await fetchImpl(input, { ...init, headers })
        if (!THROTTLED_STATUS.has(res.status)) {
          // 成功：key 已在池首（最近可用），直接返回
          return res
        }
        lastRes = res
        if (tries > 1) {
          chatLog('warn', `[failover] ${label} key 限流（HTTP ${res.status}）→ 换下一个（已试 ${i + 1}/${tries}）`)
          order.push(order.shift()!) // 429 → 头尾轮换，让其他账号优先
          if (i < tries - 1 && retryDelayMs > 0) await sleep(retryDelayMs)
        }
      }
      round += 1
      if (round < maxRounds && roundDelayMs > 0) {
        chatLog('warn', `[failover] ${label} 整池 ${order.length} 个 key 均限流，${roundDelayMs}ms 后第 ${round + 1} 轮重试`)
        await sleep(roundDelayMs)
      }
    }
    // 所有轮次耗尽：返回最后一个限流响应（SDK 转 APICallError → 免费池文案）
    chatLog('warn', `[failover] ${label} ${maxRounds} 轮 × 池内全部 key 限流，本次调用失败`)
    return lastRes ?? new Response(null, { status: 429 })
  }
}