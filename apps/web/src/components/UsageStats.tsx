/**
 * 模型使用统计（设置中心「统计」页签）：
 *  顶排：累计 Token / 峰值 Token / 最长聊天时长 / 当前连续天数 / 最长连续天数
 *  Token 活动热力图（GitHub 风格，每日/每周/累计切换 + 悬停明细）+ 每日 Token 趋势曲线（近7天/近30天/当日切换，
 *  平滑曲线 + 悬停竖线圆点 + 明细浮层，独占一行）+ 模型占比环 + 模式分布表（环与表同行）。
 * 数据源 GET /api/usage/stats（服务端按轮落盘 JSONL 聚合）；图表纯 SVG 手绘，无图表库依赖。
 * 动效：曲线描画 / 占比环扫描 / 卡片数字滚动 / 热力格渐显。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MODES } from '@story-studio/shared'

interface UsageStatsData {
  days: Array<{ date: string; label: string; byModel: Record<string, number> }>
  /** 近 30 天：同 days 结构（趋势图「近30天」） */
  month: Array<{ date: string; label: string; byModel: Record<string, number> }>
  /** 当日 0-23 时每小时每模型 tokens（趋势图「当日」） */
  todayHours: Array<{ hour: number; label: string; byModel: Record<string, number> }>
  models: Array<{ model: string; tokens: number; share: number }>
  today: number
  week: number
  total: number
  avgResponseMs: number
  calls: number
  byMode: Array<{ mode: string; tokens: number; calls: number; share: number }>
  records: number
  daily: Array<{ date: string; tokens: number; rounds: number }>
  peakTokens: number
  longestMs: number
  streakCurrent: number
  streakLongest: number
}

/** 单轮任务记录（GET /api/usage/records，最新在前） */
interface UsageRecordItem {
  at: string
  runId?: string
  sessionId?: string
  /** 任务描述（会话标题 = 首条用户消息前 40 字；旧记录可能缺失） */
  title?: string
  mode: string
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  calls?: number
}

/** 聚合后的「整任务」记录：同一会话内相邻轮次（间隔 ≤10 分钟）合并为一个任务，token/时长都按整任务累计 */
interface UsageTaskItem {
  key: string
  at: string
  title?: string
  mode: string
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  /** 该任务包含的轮数（>1 时表格角标展示） */
  rounds: number
}

/** 会话内轮次聚合窗口：两轮间隔超过此值视为两个任务（用户休息后再回来 = 新任务） */
const TASK_GAP_MS = 10 * 60 * 1000

/** 轮次记录（新→旧）→ 任务记录（新→旧）：同 sessionId 分组 + 组内按间隔切任务；
 *  无 sessionId 的旧记录各自成组。取组内最早时间、首条标题、末条模型，token/时长/轮数累计。 */
function groupIntoTasks(records: UsageRecordItem[]): UsageTaskItem[] {
  const tasks: UsageTaskItem[] = []
  let cur: UsageRecordItem[] = []
  const flush = (): void => {
    if (cur.length === 0) return
    const first = cur[0]!
    const last = cur[cur.length - 1]!
    tasks.push({
      key: first.runId ?? `${first.at}-task`,
      at: first.at,
      title: first.title ?? last.title,
      mode: first.mode,
      model: last.model,
      inputTokens: cur.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: cur.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      durationMs: cur.reduce((s, r) => s + (r.durationMs ?? 0), 0),
      rounds: cur.length,
    })
    cur = []
  }
  for (const r of records) {
    if (cur.length === 0) {
      cur.push(r)
      continue
    }
    const prev = cur[cur.length - 1]!
    const gap = new Date(prev.at).getTime() - new Date(r.at).getTime() // records 新→旧，prev 较新
    const sameSession = r.sessionId !== undefined && r.sessionId === prev.sessionId
    if (!(sameSession && gap <= TASK_GAP_MS)) flush()
    cur.push(r)
  }
  flush()
  return tasks
}

const PALETTE = ['#4cc3ff', '#34d399', '#a78bfa', '#f0a75a', '#e0483e', '#67e8f9', '#f472b6']

/** token 中文单位：≥1亿 → x.x亿；≥1万 → x.x万（整数万不带小数）；其余原样 */
function fmtCN(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) {
    const w = n / 10_000
    return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10}万`
  }
  return String(Math.round(n))
}

const modeLabel = (id: string): string => MODES.find((m) => m.id === id)?.label ?? id

/** 毫秒 → 「x小时x分 / x分钟」（紧凑无空格：窄统计卡片里不换行） */
function fmtDuration(ms: number): string {
  if (ms <= 0) return '0分钟'
  let h = Math.floor(ms / 3_600_000)
  let m = Math.round((ms % 3_600_000) / 60_000)
  if (m === 60) {
    h += 1
    m = 0
  }
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

/** 本地 ISO 时间 → 「MM-DD HH:mm」 */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 数字滚动（ease-out cubic，900ms） */
function useCountUp(target: number, duration = 900): number {
  const [v, setV] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    let raf = 0
    const from = fromRef.current
    const t0 = performance.now()
    const tick = (t: number): void => {
      const p = Math.min(1, (t - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setV(Math.round(from + (target - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return v
}

const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** ISO 日期（yyyy-MM-dd）→ 「周几」 */
function weekdayCN(date: string): string {
  return WEEKDAYS_CN[new Date(date + 'T00:00:00').getDay()]
}

/** tooltip 明细行：color 缺省表示无色点（普通文本行） */
interface TipRow {
  color?: string
  text: string
}

interface ChartTip {
  x: number
  y: number
  title: string
  rows: TipRow[]
}

/** 悬停明细浮层（fixed 跟随鼠标，不受滚动容器 overflow 裁剪） */
function TipBubble({ tip }: { tip: ChartTip }): React.JSX.Element {
  return (
    <div className="us-tip" style={{ left: tip.x, top: tip.y }}>
      <b>{tip.title}</b>
      {tip.rows.map((r, i) => (
        <span key={i} className="us-tip-row">
          {r.color && <i style={{ background: r.color }} />}
          {r.text}
        </span>
      ))}
    </div>
  )
}

/** 鼠标位置 → 提示浮层坐标（横向钳制在视口内） */
function tipAt(e: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: Math.min(Math.max(e.clientX, 110), window.innerWidth - 110), y: e.clientY }
}

/** 趋势图时间范围：近7天 / 近30天 / 当日（按小时） */
type TrendRange = 'd7' | 'd30' | 'today'

/** 趋势图单个数据点（三种范围归一后的形状） */
interface TrendPoint {
  key: string
  /** 坐标轴短标签（8月24日 / 8/24 / 14时） */
  short: string
  /** 悬停明细标题 */
  title: string
  byModel: Record<string, number>
}

/** 单调三次插值（d3 curveMonotoneX 同款，Fritsch–Carlson 切线）：
 *  保证曲线在采样点间不过冲——两段 0 之间严格贴基线，「0 → 突增」处也不会先跌破 0 再翘起 */
function monotonePath(pts: Array<[number, number]>): string {
  const n = pts.length
  if (n < 2) return ''
  const secant = (i: number, j: number): number => {
    const h = pts[j][0] - pts[i][0]
    return h === 0 ? 0 : (pts[j][1] - pts[i][1]) / h
  }
  // 内点切线：两侧斜率异号取 0（局部极值处压平），否则取双符号限幅平均
  const tangents: number[] = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const s0 = secant(i - 1, i)
    const s1 = secant(i, i + 1)
    if (s0 * s1 > 0) {
      const w = pts[i + 1][0] - pts[i - 1][0]
      const p = w === 0 ? 0 : (s0 * (pts[i + 1][0] - pts[i][0]) + s1 * (pts[i][0] - pts[i - 1][0])) / w
      tangents[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p))
    }
  }
  // 端点切线：由相邻内点切线反推（避免端点过冲）
  const endTangent = (self: number, other: number): number => {
    const h = pts[other][0] - pts[self][0]
    return h === 0 ? tangents[other] : (3 * secant(self, other) - tangents[other]) / 2
  }
  tangents[0] = endTangent(0, 1)
  tangents[n - 1] = endTangent(n - 1, n - 2)
  // 每段用两端切线生成三次贝塞尔
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const h = (x1 - x0) / 3
    d += ` C ${x0 + h} ${y0 + tangents[i] * h}, ${x1 - h} ${y1 - tangents[i + 1] * h}, ${x1} ${y1}`
  }
  return d
}

/** 每日 Token 趋势曲线（多模型平滑曲线 + 网格 + 日期轴；描画入场；悬停出竖线圆点 + 明细浮层） */
function TrendCurve({
  points,
  models,
  tickStep,
  roundsByKey,
}: {
  points: TrendPoint[]
  models: string[]
  tickStep: number
  roundsByKey?: Map<string, number>
}): React.JSX.Element {
  const [drawn, setDrawn] = useState(false)
  const [hover, setHover] = useState<{ idx: number; clientX: number; clientY: number } | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 80)
    return () => clearTimeout(t)
  }, [points])

  const W = 760
  const H = 300
  const PAD_L = 60
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 28
  const n = Math.max(1, points.length)
  const max = Math.max(1, ...points.flatMap((p) => Object.values(p.byModel)))
  const pow = 10 ** Math.floor(Math.log10(max))
  const niceMax = Math.ceil(max / pow) * pow
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const x = (i: number): number => PAD_L + (i * plotW) / Math.max(1, n - 1)
  const y = (v: number): number => PAD_T + (1 - v / niceMax) * plotH

  // 全零系列不画线（避免多条线叠在基线上），图例仍保留
  const series = models
    .map((m, mi) => ({ model: m, color: PALETTE[mi % PALETTE.length], values: points.map((p) => p.byModel[m] ?? 0) }))
    .filter((s) => s.values.some((v) => v > 0))

  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.max(0, Math.min(n - 1, Math.round(((mx - PAD_L) / plotW) * (n - 1))))
    setHover({ idx, clientX: e.clientX, clientY: e.clientY })
  }

  let tip: ChartTip | null = null
  if (hover) {
    const p = points[hover.idx]
    const total = models.reduce((s, m) => s + (p.byModel[m] ?? 0), 0)
    const rounds = roundsByKey?.get(p.key)
    tip = {
      ...tipAt({ clientX: hover.clientX, clientY: hover.clientY }),
      title: p.title,
      rows: [
        { text: `合计 ${fmtCN(total)} tokens${rounds !== undefined ? ` · ${rounds} 轮消息` : ''}` },
        ...models
          .map((m, mi) => ({ m, mi, v: p.byModel[m] ?? 0 }))
          .filter((r) => r.v > 0)
          .map((r) => ({ color: PALETTE[r.mi % PALETTE.length], text: `${r.m} · ${fmtCN(r.v)}` })),
      ],
    }
  }

  return (
    <div className="us-curve-wrap" onMouseLeave={() => setHover(null)}>
      {tip && <TipBubble tip={tip} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="us-curve" role="img" aria-label="每日 Token 趋势" onMouseMove={handleMove}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + f * plotH} y2={PAD_T + f * plotH} className="us-grid" />
            <text x={PAD_L - 6} y={PAD_T + f * plotH + 3} className="us-axis" textAnchor="end">
              {fmtCN(niceMax * (1 - f))}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % tickStep === 0 || (i === n - 1 && (n - 1) % tickStep !== 0) ? (
            <text key={p.key} x={x(i)} y={H - 8} className="us-axis" textAnchor="middle">
              {p.short}
            </text>
          ) : null,
        )}
        {hover && <line x1={x(hover.idx)} x2={x(hover.idx)} y1={PAD_T} y2={PAD_T + plotH} className="us-cursor-line" />}
        {series.map((s, si) => (
          <path
            key={s.model}
            d={monotonePath(s.values.map((v, i) => [x(i), y(v)]))}
            className="us-curve-path"
            stroke={s.color}
            pathLength={1}
            style={{
              strokeDasharray: 1,
              strokeDashoffset: drawn ? 0 : 1,
              transition: `stroke-dashoffset 1s ${si * 0.1}s ease-out`,
            }}
          />
        ))}
        {hover &&
          series.map((s) =>
            s.values[hover.idx] > 0 ? (
              <circle
                key={s.model}
                className="us-curve-dot"
                cx={x(hover.idx)}
                cy={y(s.values[hover.idx])}
                r={3.5}
                fill={s.color}
              />
            ) : null,
          )}
      </svg>
    </div>
  )
}

/** 模型占比环（多段圆弧 + 扫描入场动画 + 中心最大份额） */
function ShareDonut({ models }: { models: UsageStatsData['models'] }): React.JSX.Element {
  const [swept, setSwept] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSwept(true), 120)
    return () => clearTimeout(t)
  }, [])
  const R = 54
  const C = 2 * Math.PI * R
  let acc = 0
  const top = models[0]
  return (
    <div className="us-donut-wrap">
      <svg viewBox="0 0 140 140" className="us-donut" role="img" aria-label="模型占比">
        <circle cx="70" cy="70" r={R} fill="none" className="us-donut-track" strokeWidth={14} />
        {models.map((m, i) => {
          const frac = Math.max(0, Math.min(1, m.share))
          const dash = `${swept ? frac * C : 0} ${C}`
          const offset = -acc * C
          acc += frac
          return (
            <circle
              key={m.model}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={14}
              strokeDasharray={dash}
              strokeDashoffset={offset}
              transform="rotate(-90 70 70)"
              style={{ transition: `stroke-dasharray 1s ${i * 0.1}s cubic-bezier(0.22,0.61,0.36,1)` }}
            />
          )
        })}
        <text x="70" y="66" className="us-donut-pct" textAnchor="middle">
          {top ? Math.round(top.share * 100) : 0}%
        </text>
        <text x="70" y="82" className="us-donut-sub" textAnchor="middle">
          {top?.model ?? '—'}
        </text>
      </svg>
      <div className="us-legend">
        {models.map((m, i) => (
          <span key={m.model} className="us-legend-item">
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            {m.model}
          </span>
        ))}
      </div>
    </div>
  )
}

type HeatMode = 'daily' | 'weekly' | 'cumulative'

interface HeatCell {
  key: string
  label: string
  tokens: number
  rounds: number
  level: number
}

/** Token 活动热力图（GitHub 风格）：每日 7 行网格（带周几标注）/ 每周单行 / 累计递增；悬停出明细提示 */
function TokenHeatmap({ daily }: { daily: UsageStatsData['daily'] }): React.JSX.Element {
  const [mode, setMode] = useState<HeatMode>('daily')
  const [tip, setTip] = useState<ChartTip | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const cells = useMemo<HeatCell[]>(() => {
    if (mode === 'weekly') {
      // 按自然周（周一起）聚合：每周一格
      const map = new Map<string, { tokens: number; rounds: number; start: string; end: string }>()
      for (const d of daily) {
        const dt = new Date(d.date + 'T00:00:00')
        const dow = (dt.getDay() + 6) % 7 // 周一=0
        dt.setDate(dt.getDate() - dow)
        const k = dt.toISOString().slice(0, 10)
        const cur = map.get(k) ?? { tokens: 0, rounds: 0, start: k, end: d.date }
        cur.tokens += d.tokens
        cur.rounds += d.rounds
        cur.end = d.date
        map.set(k, cur)
      }
      const list = [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
      const max = Math.max(1, ...list.map(([, v]) => v.tokens))
      return list.map(([k, v]) => ({
        key: k,
        label: `${v.start.slice(5).replace('-', '/')}~${v.end.slice(5).replace('-', '/')}`,
        tokens: v.tokens,
        rounds: v.rounds,
        level: v.tokens <= 0 ? 0 : Math.min(4, 1 + Math.floor((v.tokens / max) * 4.2)),
      }))
    }
    let run = 0
    const list = daily.map((d) => {
      run += d.tokens
      return { date: d.date, tokens: mode === 'cumulative' ? run : d.tokens, rounds: d.rounds }
    })
    const max = Math.max(1, ...list.map((v) => v.tokens))
    return list.map((v) => ({
      key: v.date,
      label: v.date.replaceAll('-', '/'),
      tokens: v.tokens,
      rounds: v.rounds,
      level: v.tokens <= 0 ? 0 : Math.min(4, 1 + Math.floor((v.tokens / max) * 4.2)),
    }))
  }, [daily, mode])

  // 每日/累计 → 按周分列的 7 行网格（周一为首行，周日起收列）；缺口补占位格，保证任何数据量下都是完整 7 行，
  // 与左侧周几标注逐行对齐。每周模式 → 单行。
  const grid = useMemo<Array<Array<HeatCell | null>>>(() => {
    if (mode === 'weekly') return [cells]
    const cols: Array<Array<HeatCell | null>> = []
    let cur: Array<HeatCell | null> = []
    for (const c of cells) {
      const dow = (new Date(c.key + 'T00:00:00').getDay() + 6) % 7
      if (dow === 0 && cur.length > 0) {
        cols.push(cur)
        cur = []
      }
      while (cur.length < dow) cur.push(null)
      cur.push(c)
    }
    if (cur.length > 0) {
      while (cur.length < 7) cur.push(null)
      cols.push(cur)
    }
    return cols
  }, [cells, mode])

  const showTip = (e: React.MouseEvent<HTMLDivElement>, cell: HeatCell): void => {
    const rows: TipRow[] = [
      {
        text: `${mode === 'cumulative' ? '累计 ' : ''}${fmtCN(cell.tokens)} tokens · ${cell.rounds} 轮消息`,
      },
    ]
    setTip({
      ...tipAt(e),
      title:
        mode === 'weekly'
          ? `${cell.label} 本周合计`
          : `${cell.key.slice(0, 4)}年${Number(cell.key.slice(5, 7))}月${Number(cell.key.slice(8, 10))}日 · ${weekdayCN(cell.key)}`,
      rows,
    })
  }

  return (
    <div className="us-card us-heat-card">
      <div className="us-heat-head">
        <span className="us-card-title">Token 活动</span>
        <div className="us-heat-toggle">
          {(
            [
              ['daily', '每日'],
              ['weekly', '每周'],
              ['cumulative', '累计'],
            ] as Array<[HeatMode, string]>
          ).map(([m, label]) => (
            <button key={m} type="button" className={`us-heat-btn${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="us-heat" ref={wrapRef} onMouseLeave={() => setTip(null)}>
        {tip && <TipBubble tip={tip} />}
        <div className="us-heat-body">
          {mode !== 'weekly' && (
            <div className="us-heat-days" aria-hidden="true">
              {['一', '', '三', '', '五', '', '日'].map((t, i) => (
                <span key={i}>{t}</span>
              ))}
            </div>
          )}
          <div className="us-heat-main">
            <div className={`us-heat-grid${mode === 'weekly' ? ' weekly' : ''}`}>
              {grid.map((col, ci) => (
                <div key={ci} className="us-heat-col">
                  {col.map((c, ri) =>
                    c ? (
                      <div key={c.key} className={`us-heat-cell lv${c.level}`} onMouseEnter={(e) => showTip(e, c)} />
                    ) : (
                      <div key={`${ci}-${ri}`} className="us-heat-cell blank" />
                    ),
                  )}
                </div>
              ))}
            </div>
            <div className="us-heat-months">
              {(() => {
                const labels: Array<{ i: number; text: string }> = []
                let lastMonth = ''
                cells.forEach((c, i) => {
                  const m = c.key.slice(5, 7)
                  if (m !== lastMonth) {
                    labels.push({ i, text: `${Number(m)}月` })
                    lastMonth = m
                  }
                })
                return labels.map((l) => (
                  <span key={l.i + l.text} className="us-heat-month" style={{ left: `${(l.i / Math.max(1, cells.length)) * 100}%` }}>
                    {l.text}
                  </span>
                ))
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function UsageStats(): React.JSX.Element {
  const [data, setData] = useState<UsageStatsData | null>(null)
  const [err, setErr] = useState(false)
  // 最近任务记录：挂载加载一次 + 监听 App 广播的 usage:new-record（agent 任务完成的最终快照）实时刷新
  // 拉取原始轮次记录（多拉以保证聚合后的任务数足够），前端按 session+时间窗聚合成「整任务」
  const [records, setRecords] = useState<UsageRecordItem[] | null>(null)
  const [recordsErr, setRecordsErr] = useState(false)
  // 趋势图时间范围（近7天 / 近30天 / 当日）
  const [range, setRange] = useState<TrendRange>('d7')

  /** 轮次 → 整任务（同会话相邻 ≤10 分钟合并；时长与 token 统一为整任务口径） */
  const tasks = useMemo(() => (records ? groupIntoTasks(records).slice(0, 30) : null), [records])

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/usage/stats')
        if (!r.ok) throw new Error(String(r.status))
        setData((await r.json()) as UsageStatsData)
      } catch {
        setErr(true)
      }
    })()
  }, [])

  // 最近任务记录：挂载加载一次 + 监听 App 广播的 usage:new-record（agent 任务完成的最终快照）实时刷新
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void (async () => {
        try {
          const r = await fetch('/api/usage/records?limit=80')
          if (!r.ok) throw new Error(String(r.status))
          if (alive) {
            setRecords((await r.json()) as UsageRecordItem[])
            setRecordsErr(false)
          }
        } catch {
          if (alive) setRecordsErr(true)
        }
      })()
    }
    load()
    window.addEventListener('usage:new-record', load)
    return () => {
      alive = false
      window.removeEventListener('usage:new-record', load)
    }
  }, [])

  // 卡片数字滚动（hooks 必须无条件调用，目标值随数据到达平滑滚动）
  const todayV = useCountUp(data?.today ?? 0)
  const weekV = useCountUp(data?.week ?? 0)
  const totalV = useCountUp(data?.total ?? 0)
  const avgV = useCountUp(data?.avgResponseMs ?? 0)
  const peakV = useCountUp(data?.peakTokens ?? 0)

  if (err) return <div className="us-empty">统计加载失败——请确认服务端已重启到最新版本。</div>
  if (!data) return <div className="us-empty">统计加载中…</div>
  if (data.records === 0)
    return <div className="us-empty">暂无统计数据——完成一次对话后，这里会按轮累积消耗（按模型/模式/日期维度）。</div>

  const models = data.models.slice(0, 6)
  // 日期 → 当日轮数（趋势图悬停明细用）
  const roundsByDate = new Map(data.daily.map((d) => [d.date, d.rounds]))

  // 三档时间范围 → 归一化趋势点序列
  let trendPoints: TrendPoint[]
  let tickStep: number
  let roundsByKey: Map<string, number> | undefined
  if (range === 'today') {
    trendPoints = data.todayHours.map((h) => ({
      key: `h${h.hour}`,
      short: h.label,
      title: `今天 ${String(h.hour).padStart(2, '0')}:00 – ${String(h.hour).padStart(2, '0')}:59`,
      byModel: h.byModel,
    }))
    tickStep = 3
  } else {
    const src = range === 'd30' ? data.month : data.days
    trendPoints = src.map((d) => ({
      key: d.date,
      short: range === 'd30' ? d.label : `${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8, 10))}日`,
      title: `${d.date.slice(0, 4)}年${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8, 10))}日 · ${weekdayCN(d.date)}`,
      byModel: d.byModel,
    }))
    tickStep = range === 'd30' ? 5 : 1
    roundsByKey = roundsByDate
  }

  return (
    <div className="usage-stats">
      <div className="us-head">
        <b>Token 消耗统计</b>
        <span>模型调用与消耗趋势 · 共 {data.records} 轮</span>
      </div>

      {/* 顶排：累计 / 峰值 / 最长聊天时长 / 连续天数 */}
      <div className="us-cards us-cards-five">
        <StatCard label="累计 Token 数" value={totalV} fmt={fmtCN} />
        <StatCard label="峰值 Token 数" value={peakV} fmt={fmtCN} />
        <StatCard label="最长聊天时长" value={data.longestMs} fmt={fmtDuration} />
        <StatCard label="当前连续天数" value={data.streakCurrent} fmt={(n) => `${n} 天`} />
        <StatCard label="最长连续天数" value={data.streakLongest} fmt={(n) => `${n} 天`} />
      </div>

      <TokenHeatmap daily={data.daily} />

      {/* 每日 Token 趋势曲线：独占一行放大展示，时间范围可切换 */}
      <div className="us-card us-chart-card">
        <div className="us-chart-head">
          <span className="us-card-title">每日 Token 趋势图</span>
          <div className="us-heat-toggle">
            {(
              [
                ['d7', '近7天'],
                ['d30', '近30天'],
                ['today', '当日'],
              ] as Array<[TrendRange, string]>
            ).map(([r, label]) => (
              <button key={r} type="button" className={`us-heat-btn${range === r ? ' on' : ''}`} onClick={() => setRange(r)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="us-legend">
          {models.map((m, i) => (
            <span key={m.model} className="us-legend-item">
              <i style={{ background: PALETTE[i % PALETTE.length] }} />
              {m.model}
            </span>
          ))}
        </div>
        <TrendCurve points={trendPoints} models={models.map((m) => m.model)} tickStep={tickStep} roundsByKey={roundsByKey} />
      </div>

      {/* 模型占比环 + 任务类型分布表：同行展示 */}
      <div className="us-charts">
        <div className="us-card us-donut-card">
          <div className="us-card-title">模型占比</div>
          <ShareDonut models={models} />
        </div>
        <div className="us-card us-table-card">
          <table className="us-table">
            <thead>
              <tr>
                <th>任务类型</th>
                <th>消耗 Token</th>
                <th>调用次数</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              {data.byMode.map((m, i) => (
                <tr key={m.mode} style={{ animationDelay: `${i * 0.06}s` }}>
                  <td>{modeLabel(m.mode)}</td>
                  <td>{fmtCN(m.tokens)}</td>
                  <td>{m.calls}</td>
                  <td>
                    <span className="us-share">
                      <i style={{ width: `${Math.round(m.share * 100)}%` }} />
                      {Math.round(m.share * 100)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="us-cards">
        <StatCard label="今日消耗" value={todayV} fmt={fmtCN} />
        <StatCard label="本周消耗" value={weekV} fmt={fmtCN} />
        <StatCard label="累计消耗" value={totalV} fmt={fmtCN} />
        <StatCard label="平均响应" value={avgV} fmt={(n) => `${(n / 1000).toFixed(1)}s`} />
      </div>

      {/* 最近任务记录：按「整任务」聚合展示（同会话相邻轮次合并；任务完成后自动置顶） */}
      <div className="us-card us-records-card">
        <div className="us-records-head">
          <span className="us-card-title">最近任务记录</span>
          <span className="us-records-sub">
            {recordsErr ? '记录加载失败' : tasks ? `最新 ${tasks.length} 个任务 · 同一任务的连续轮次已合并统计` : '记录加载中…'}
          </span>
        </div>
        {tasks && tasks.length > 0 ? (
          <div className="us-records-scroll">
            <table className="us-table us-records">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>任务描述</th>
                  <th>模型</th>
                  <th>时长</th>
                  <th>Token 消耗</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.key} style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
                    <td className="us-records-time">{fmtTime(t.at)}</td>
                    <td className="us-records-title">
                      <span className="us-records-text" title={t.title || modeLabel(t.mode)}>
                        {t.title || modeLabel(t.mode)}
                      </span>
                      <i>
                        {modeLabel(t.mode)}
                        {t.rounds > 1 ? ` · ${t.rounds} 轮` : ''}
                      </i>
                    </td>
                    <td className="us-records-model" title={t.model}>
                      {t.model}
                    </td>
                    <td className="us-records-dur">{fmtDuration(t.durationMs)}</td>
                    <td className="us-records-token">
                      <b>{fmtCN(t.inputTokens + t.outputTokens)}</b>
                      <span className="us-records-token-sub">输入 {fmtCN(t.inputTokens)} · 输出 {fmtCN(t.outputTokens)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="us-empty">暂无任务记录</div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, fmt }: { label: string; value: number; fmt: (n: number) => string }): React.JSX.Element {
  return (
    <div className="us-card us-stat">
      <span className="us-stat-label">{label}</span>
      <b className="us-stat-value">{fmt(value)}</b>
    </div>
  )
}
