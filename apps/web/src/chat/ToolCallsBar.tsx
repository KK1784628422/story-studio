/**
 * 工具调用任务栏（参考 工具调用任务栏（必须）.txt · Manus 风格）：
 * - 折叠头：堆叠旋转的彩色图标（按工具去重、超 8 个显示 +N）+「已调用 N 个工具」+ 实时当前动作（执行中）+ 箭头
 * - 展开体：竖链时间线——每行 彩色瓷片图标 + 竖连接线 + 人话描述（工具名·参数摘要）+ 状态徽标，点击行看 Input/Output
 * - 展开策略（用户拍板）：执行中默认展开（规避 §93「收起看不到在调什么」），本轮结束后自动收起为一行（仍可手动展开）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon.tsx'
import { metaOf } from './toolMeta.ts'
import { toolBadge, type ToolPartLike } from './ToolCard.tsx'

const MAX_STACK = 8

export function ToolCallsBar({ parts, live }: { parts: ToolPartLike[]; live: boolean }): React.JSX.Element | null {
  const [open, setOpen] = useState(live)
  const [detail, setDetail] = useState<Set<number>>(new Set())
  const wasLiveRef = useRef(live)
  // 执行中 → 展开；本轮刚结束（live true→false）→ 自动收起（用户仍可手动展开）
  useEffect(() => {
    const was = wasLiveRef.current
    wasLiveRef.current = live
    if (live) setOpen(true)
    else if (was && !live) setOpen(false)
  }, [live])

  const stack = useMemo(() => {
    const seen = new Set<string>()
    const uniq: ToolPartLike[] = []
    for (const p of parts) {
      const n = p.type.replace(/^tool-/, '')
      if (seen.has(n)) continue
      seen.add(n)
      uniq.push(p)
    }
    return uniq
  }, [parts])

  if (parts.length === 0) return null
  const last = parts[parts.length - 1]!
  const lastMeta = metaOf(last.type.replace(/^tool-/, ''))
  const lastSummary = lastMeta.summarize((last.input ?? {}) as Record<string, unknown>)
  const running = parts.some((p) => p.state === 'input-available' || p.state === 'input-streaming')

  const toggleDetail = (i: number) =>
    setDetail((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className={`tcb${open ? ' open' : ''}`}>
      <button type="button" className="tcb-head" onClick={() => setOpen((v) => !v)}>
        <span className="tcb-stack">
          {stack.slice(0, MAX_STACK).map((p, i) => {
            const m = metaOf(p.type.replace(/^tool-/, ''))
            return (
              <span
                key={`${m.label}-${i}`}
                className="tcb-chip"
                style={{ color: m.color, zIndex: i, rotate: stack.length > 1 ? (i % 2 ? '-8deg' : '8deg') : '0deg' }}
                title={m.label}
              >
                <Icon name={m.icon} size={13} />
              </span>
            )
          })}
          {stack.length > MAX_STACK && <span className="tcb-more">+{stack.length - MAX_STACK}</span>}
        </span>
        <span className="tcb-label">
          {running ? '正在调用工具' : `已调用 ${parts.length} 个工具`}
        </span>
        {live && running && (
          <span className="tcb-now" title={`${lastMeta.label} · ${lastSummary}`}>
            <i className="tcb-pulse" />
            {lastMeta.label}
            {lastSummary ? ` · ${lastSummary}` : ''}
          </span>
        )}
        <span className="tcb-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="tcb-body">
          {parts.map((p, i) => {
            const name = p.type.replace(/^tool-/, '')
            const m = metaOf(name)
            const input = (p.input ?? {}) as Record<string, unknown>
            const badge = toolBadge(p)
            const hasDetail = p.input !== undefined || p.output !== undefined || p.error !== undefined
            const isOpen = detail.has(i)
            return (
              <div key={p.toolCallId ?? i} className="tcb-row">
                <div className="tcb-rail">
                  <span className="tcb-tile" style={{ color: m.color }}>
                    <Icon name={m.icon} size={14} />
                  </span>
                  {i < parts.length - 1 && <span className="tcb-line" />}
                </div>
                <div className="tcb-main">
                  <button
                    type="button"
                    className={`tcb-desc${hasDetail ? ' clickable' : ''}`}
                    onClick={() => hasDetail && toggleDetail(i)}
                  >
                    <span className="tcb-name">{m.label}</span>
                    <span className="tcb-sum">{m.summarize(input)}</span>
                    {badge.text && (
                      <span className={`tcb-badge ${badge.tone === 'ok' ? 'ok' : badge.tone === 'bad' ? 'bad' : ''}`}>
                        {badge.icon && <Icon name={badge.icon} size={12} />} {badge.text}
                      </span>
                    )}
                    {hasDetail && <span className="tcb-caret sm">{isOpen ? '▾' : '▸'}</span>}
                  </button>
                  {isOpen && hasDetail && (
                    <div className="tcb-detail">
                      {p.input !== undefined && (
                        <div className="tcb-dsec">
                          <span className="tcb-dlabel">输入</span>
                          <pre>{JSON.stringify(p.input, null, 2)}</pre>
                        </div>
                      )}
                      {p.state === 'output-available' && p.output !== undefined && (
                        <div className="tcb-dsec">
                          <span className="tcb-dlabel">输出</span>
                          <pre>{outText(p.output)}</pre>
                        </div>
                      )}
                      {p.state === 'output-error' && (
                        <div className="tcb-dsec">
                          <span className="tcb-dlabel">错误</span>
                          <pre>{String(p.error ?? '')}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function outText(output: unknown): string {
  if (output === undefined || output === null) return String(output)
  if (typeof output === 'string') return output
  const obj = output as Record<string, unknown>
  const gate = obj.gate as { detail?: string } | null | undefined
  if (gate?.detail) return JSON.stringify({ ...obj, gate: '⬇ 见下方门禁报告' }, null, 2) + '\n── 门禁报告 ──\n' + gate.detail
  return JSON.stringify(output, null, 2)
}
