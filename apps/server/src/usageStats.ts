/**
 * 模型使用统计：每轮 token 消耗落盘（JSONL）+ 聚合查询（近 7 天趋势/模型占比/今日周累计/平均耗时/模式分布）。
 * 记录以「一轮 Agent 运行（最终快照）」为粒度，写入 logs/usage-stats.jsonl；服务重启不丢。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageRecord {
  /** 本地 ISO 时间（含时区） */
  at: string
  /** 轮次幂等键（session+时间戳）：同 runId 的重复落盘视为同一轮（兜底记录被最终快照覆盖） */
  runId?: string
  /** 所属会话 id（前端「最近任务记录」按 session 聚合成整任务；旧记录可能缺失） */
  sessionId?: string
  /** 任务描述（会话标题 = 首条用户消息前 40 字；旧记录可能缺失） */
  title?: string
  mode: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 本轮总耗时 ms（仅最终快照 >0） */
  durationMs: number
  capacityTokens: number
}

let statsFile = ''

export function initUsageStats(rootDir: string): void {
  const dir = join(rootDir, 'logs')
  mkdirSync(dir, { recursive: true })
  statsFile = join(dir, 'usage-stats.jsonl')
}

/** 追加一条快照记录。
 *  upsertByRunId：文件末条 runId 与本条相同时覆盖末条（而非追加）——用于「SSE 兜底先落、
 *  后台 agent 最终快照后到」场景的幂等合并，保证同一轮只计一次且取最完整值。
 *  旧记录（无 runId）不受影响，直接追加。 */
export function appendUsageRecord(rec: UsageRecord, opts?: { upsertByRunId?: boolean }): void {
  if (!statsFile) return
  try {
    if (opts?.upsertByRunId && rec.runId) {
      let text = ''
      try {
        text = existsSync(statsFile) ? readFileSync(statsFile, 'utf8') : ''
      } catch {
        text = ''
      }
      const lines = text.split('\n').filter((l) => l.trim())
      if (lines.length > 0) {
        try {
          const lastRec = JSON.parse(lines[lines.length - 1]) as UsageRecord
          if (lastRec.runId === rec.runId) {
            lines[lines.length - 1] = JSON.stringify(rec)
            writeFileSync(statsFile, `${lines.join('\n')}\n`, 'utf8')
            return
          }
        } catch {
          // 末条损坏（半行写入等）→ 按追加处理
        }
      }
    }
    appendFileSync(statsFile, `${JSON.stringify(rec)}\n`, 'utf8')
  } catch {
    // 统计落盘失败不阻塞对话主流程
  }
}

/** 本地日键：字符串直接取前 10 位（localTimestamp 产物）；Date 按本地年月日拼（toISOString 是 UTC，会错位一天） */
const dayKey = (v: string | Date): string => {
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface UsageStats {
  /** 近 7 天：每天每模型 token 总量（输入+输出），趋势图「近7天」数据源 */
  days: Array<{ date: string; label: string; byModel: Record<string, number> }>
  /** 近 30 天：同 days 结构，趋势图「近30天」数据源 */
  month: Array<{ date: string; label: string; byModel: Record<string, number> }>
  /** 当日 0-23 时：每小时每模型 token 总量，趋势图「当日」数据源 */
  todayHours: Array<{ hour: number; label: string; byModel: Record<string, number> }>
  /** 模型占比：总 token 份额 */
  models: Array<{ model: string; tokens: number; share: number }>
  today: number
  week: number
  total: number
  /** 全部轮次的平均耗时 ms */
  avgResponseMs: number
  calls: number
  /** 模式分布（任务类型表） */
  byMode: Array<{ mode: string; tokens: number; calls: number; share: number }>
  records: number
  /** 全量日序列（升序，含空缺日 tokens=0）：Token 活动热力图数据源 */
  daily: Array<{ date: string; tokens: number; rounds: number }>
  /** 单日峰值 token（峰值卡片） */
  peakTokens: number
  /** 单轮最长耗时 ms（最长聊天时长卡片） */
  longestMs: number
  /** 当前连续活跃天数（截至今天或昨天） */
  streakCurrent: number
  /** 最长连续活跃天数 */
  streakLongest: number
}

/** 读取全量 JSONL 记录（损坏行跳过）；文件不存在/不可读返回空数组 */
function readAllRows(): UsageRecord[] {
  if (!statsFile || !existsSync(statsFile)) return []
  const rows: UsageRecord[] = []
  try {
    const text = readFileSync(statsFile, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as UsageRecord)
      } catch {
        // 跳过损坏行
      }
    }
  } catch {
    return []
  }
  return rows
}

/** 最近 N 条轮次记录（最新在前；设置统计页「最近任务记录」列表数据源） */
export function listUsageRecords(limit = 20): UsageRecord[] {
  return readAllRows()
    .reverse()
    .slice(0, limit)
}

/** 聚合：读取 JSONL 全量（行数=轮数，量级很小），按本地日聚合 */
export function aggregateUsageStats(): UsageStats {
  const out: UsageStats = {
    days: [],
    month: [],
    todayHours: [],
    models: [],
    today: 0,
    week: 0,
    total: 0,
    avgResponseMs: 0,
    calls: 0,
    byMode: [],
    records: 0,
    daily: [],
    peakTokens: 0,
    longestMs: 0,
    streakCurrent: 0,
    streakLongest: 0,
  }
  const rows = readAllRows()
  out.records = rows.length
  if (rows.length === 0) return out

  // 近 7 天日键（本地时间；week 卡片口径沿用）
  const dayKeys: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dayKeys.push(dayKey(d))
  }

  /** 近 n 天本地日键 + 短标签（趋势图通用序列） */
  const daySeriesKeys = (n: number): Array<{ key: string; label: string }> => {
    const list: Array<{ key: string; label: string }> = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      list.push({ key: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}` })
    }
    return list
  }
  const nowDay = dayKey(new Date())

  const byModel = new Map<string, number>()
  const byModeMap = new Map<string, { tokens: number; calls: number }>()
  let durSum = 0
  let durN = 0

  for (const r of rows) {
    const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
    out.total += tokens
    out.calls += r.calls ?? 0
    if (r.durationMs > 0) {
      durSum += r.durationMs
      durN += 1
    }
    const key = dayKey(r.at)
    if (key === nowDay) out.today += tokens
    if (dayKeys.includes(key)) out.week += tokens
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + tokens)
    const bm = byModeMap.get(r.mode) ?? { tokens: 0, calls: 0 }
    bm.tokens += tokens
    bm.calls += 1
    byModeMap.set(r.mode, bm)
  }

  out.avgResponseMs = durN > 0 ? Math.round(durSum / durN) : 0
  /** 按日键聚合每模型 token 总量（趋势图通用序列构建） */
  const buildByModelSeries = (keys: Array<{ key: string; label: string }>) =>
    keys.map(({ key, label }) => {
      const byM: Record<string, number> = {}
      for (const r of rows) {
        if (dayKey(r.at) !== key) continue
        byM[r.model] = (byM[r.model] ?? 0) + (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
      }
      return { date: key, label, byModel: byM }
    })
  out.days = buildByModelSeries(daySeriesKeys(7))
  out.month = buildByModelSeries(daySeriesKeys(30))

  // 当日 24 小时序列（每小时各模型 token 总量；「当日」趋势数据源）
  const hourBuckets: Array<Record<string, number>> = Array.from({ length: 24 }, () => ({}))
  for (const r of rows) {
    if (dayKey(r.at) !== nowDay) continue
    const h = new Date(r.at).getHours()
    hourBuckets[h][r.model] = (hourBuckets[h][r.model] ?? 0) + (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
  }
  out.todayHours = hourBuckets.map((byM, hour) => ({ hour, label: `${hour}时`, byModel: byM }))

  out.models = [...byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens, share: out.total > 0 ? tokens / out.total : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
  out.byMode = [...byModeMap.entries()]
    .map(([mode, v]) => ({ mode, tokens: v.tokens, calls: v.calls, share: out.total > 0 ? v.tokens / out.total : 0 }))
    .sort((a, b) => b.tokens - a.tokens)

  // 全量日序列（含空缺日补 0）+ 峰值 + 连续天数（活跃日 = tokens>0 的本地日）
  const perDay = new Map<string, { tokens: number; rounds: number }>()
  for (const r of rows) {
    const k = dayKey(r.at)
    const d = perDay.get(k) ?? { tokens: 0, rounds: 0 }
    d.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
    d.rounds += 1
    perDay.set(k, d)
  }
  if (perDay.size > 0) {
    const keys = [...perDay.keys()].sort()
    const first = new Date(keys[0] + 'T00:00:00')
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (let d = first; d <= today; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d)
      const v = perDay.get(k) ?? { tokens: 0, rounds: 0 }
      out.daily.push({ date: k, tokens: v.tokens, rounds: v.rounds })
      if (v.tokens > out.peakTokens) out.peakTokens = v.tokens
    }
    // 连续天数：把活跃日集合做连续段扫描（末段含今天/昨天 → 当前连续）
    const active = new Set([...perDay.keys()].filter((k) => (perDay.get(k)?.tokens ?? 0) > 0))
    let run = 0
    let last: string | null = null
    for (const k of [...active].sort()) {
      if (last !== null) {
        const prev = new Date(last + 'T00:00:00')
        const cur = new Date(k + 'T00:00:00')
        const gap = Math.round((cur.getTime() - prev.getTime()) / 86_400_000)
        run = gap === 1 ? run + 1 : 1
      } else {
        run = 1
      }
      if (run > out.streakLongest) out.streakLongest = run
      last = k
    }
    if (active.size > 0) {
      const yesterday = new Date(today)
      yesterday.setDate(today.getDate() - 1)
      const tail = dayKey(today)
      const yKey = dayKey(yesterday)
      if (active.has(tail) || active.has(yKey)) out.streakCurrent = run
      else out.streakCurrent = 0
    }
  }
  if (durN > 0) out.longestMs = Math.max(...rows.filter((r) => r.durationMs > 0).map((r) => r.durationMs))
  return out
}

/** 文件体积守门：超过 5MB 时轮转为 .jsonl.bak（重新累计，量级极低频触发） */
export function rotateUsageStatsIfLarge(): void {
  if (!statsFile || !existsSync(statsFile)) return
  try {
    if (statSync(statsFile).size > 5 * 1024 * 1024) {
      renameSync(statsFile, `${statsFile}.bak`)
    }
  } catch {
    /* 忽略 */
  }
}
