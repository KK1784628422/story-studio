/**
 * M3 报告面板：.story-studio/reports/ 下的审稿 / 扫榜 / 诊断报告。
 * 左侧列表（mtime 倒序，WS file:changed kind=report 自动刷新）+ 右侧 Markdown 渲染。
 */
import { useCallback, useEffect, useState } from 'react'
import MarkdownIt from 'markdown-it'
import type { WsEvent } from '@story-studio/shared'
import { fetchReports, fetchWorkspaceFile, type ReportBrief } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

export function ReportPanel({ wsEvent }: { wsEvent?: WsEvent | null }): React.JSX.Element {
  const [reports, setReports] = useState<ReportBrief[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (autoSelect = false) => {
    try {
      const list = await fetchReports()
      setReports(list)
      if (autoSelect || !selected) {
        if (list.length > 0 && (!selected || !list.some((r) => r.path === selected))) {
          setSelected(list[0].path)
        } else if (list.length === 0) {
          setSelected(null)
          setContent('')
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [selected])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  // WS：新报告落盘 → 刷新列表并选中新报告
  useEffect(() => {
    if (wsEvent?.type === 'file:changed' && wsEvent.kind === 'report') {
      setSelected(wsEvent.path)
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsEvent])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    fetchWorkspaceFile(selected)
      .then((c) => {
        if (!cancelled) setContent(c ?? '（报告读取失败）')
      })
      .catch(() => setContent('（报告读取失败）'))
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div className="report-panel">
      <div className="rp-list">
        <div className="rp-list-head">
          <span className="rp-badge"><Icon name="chart-bar" size={13} /> 报告</span>
          <button type="button" className="rp-refresh" onClick={() => void refresh()}>
            ⟳
          </button>
        </div>
        {loading && <div className="rp-empty">加载中…</div>}
        {!loading && reports.length === 0 && (
          <div className="rp-empty">
            暂无报告。
            <br />
            审稿（「审查第 7-9 章」）/ 扫榜产物会出现在这里。
          </div>
        )}
        {reports.map((r) => (
          <button
            key={r.path}
            type="button"
            className={`rp-item${selected === r.path ? ' active' : ''}`}
            onClick={() => setSelected(r.path)}
          >
            <span className="rp-name">{r.name.replace(/\.md$/, '')}</span>
            <span className="rp-meta">
              {new Date(r.mtime).toLocaleString('zh-CN', { hour12: false })} · {(r.bytes / 1000).toFixed(1)}KB
            </span>
          </button>
        ))}
      </div>
      <div className="rp-body">
        {selected ? (
          <div className="rp-markdown markdown-body" dangerouslySetInnerHTML={{ __html: md.render(content) }} />
        ) : (
          <div className="rp-empty">← 选择一份报告查看</div>
        )}
      </div>
    </div>
  )
}
