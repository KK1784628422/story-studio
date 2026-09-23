/**
 * 底部日志面板（状态栏日志按钮弹出，可视化栏下方，参考 VS Code 问题面板）：
 * 级别筛选（全部/警告/错误）+ 文本筛选 + 自动跟随滚动（用户上滚即暂停跟随）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

export interface LogEntry {
  level: string
  msg: string
  at: string
}

type LevelFilter = 'all' | 'warn' | 'error'

export function LogPanel({
  logs,
  onClose,
  onClear,
}: {
  logs: LogEntry[]
  onClose: () => void
  onClear: () => void
}): React.JSX.Element {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  /** 用户滚离底部即暂停自动跟随，滚回底部恢复 */
  const pinnedRef = useRef(true)

  const errCount = logs.filter((l) => l.level === 'error').length
  const warnCount = logs.filter((l) => l.level === 'warn').length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter(
      (l) => (level === 'all' || l.level === level) && (!q || l.msg.toLowerCase().includes(q)),
    )
  }, [logs, level, query])

  useEffect(() => {
    const el = listRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  return (
    <section className="log-panel" role="region" aria-label="日志面板">
      <div className="log-panel-head">
        <span className="log-panel-title">
          <Icon name="clipboard-list" size={13} /> 日志
        </span>
        <div className="log-panel-filters">
          <button
            type="button"
            className={`lp-chip${level === 'all' ? ' on' : ''}`}
            onClick={() => setLevel('all')}
          >
            全部 {logs.length}
          </button>
          <button
            type="button"
            className={`lp-chip lp-warn${level === 'warn' ? ' on' : ''}`}
            onClick={() => setLevel('warn')}
          >
            <Icon name="warning" size={11} /> {warnCount}
          </button>
          <button
            type="button"
            className={`lp-chip lp-bad${level === 'error' ? ' on' : ''}`}
            onClick={() => setLevel('error')}
          >
            <Icon name="x-circle" size={11} /> {errCount}
          </button>
          <input
            className="lp-filter"
            value={query}
            placeholder="筛选日志内容…"
            aria-label="筛选日志内容"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="log-panel-actions">
          <button type="button" className="btn-ghost" title="清空日志" onClick={onClear}>
            清空
          </button>
          <button type="button" className="drawer-close" title="关闭" aria-label="关闭日志面板" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div
        className="log-panel-body log-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {filtered.length === 0 && (
          <div className="session-empty">{logs.length === 0 ? '暂无日志——发起对话后这里会实时显示。' : '无匹配日志。'}</div>
        )}
        {filtered.map((l, i) => (
          <div key={`${l.at}-${i}`} className={`log-line log-${l.level}`}>
            <span className="log-time">{l.at.slice(11, 19)}</span>
            <span className="log-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
