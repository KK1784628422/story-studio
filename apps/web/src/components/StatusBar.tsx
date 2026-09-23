/**
 * 底部状态栏（VS Code 风格）：
 *  左：WebSocket 连接状态 + 上下文容量（agent:usage 驱动，点击弹构成详情）；
 *  右：日志按钮（⊗错误 / ⚠警告 计数实时变化，点击弹出日志面板）+ 书架 / 设置入口。
 *  Agent 实时状态在顶栏动态胶囊（TopCapsule.tsx，复用桌宠 13 态仲裁）。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

/** token 中文单位：≥1亿 → x.x亿；≥1万 → x.x万；其余原样 */
export function fmtWan(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) {
    const w = n / 10_000
    return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10}万`
  }
  return String(Math.round(n))
}

/** 上下文构成弹窗数据（WsEvent agent:usage 的形状子集） */
interface CtxSnap {
  inputTokens: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  lastInputTokens: number
  breakdown: { system: number; skills: number; tools: number; messages: number; other: number }
  capacity: { model: string; tokens: number }
}

export function StatusBar({
  connected,
  ctxInfo,
  ctxSnap,
  ctxAvgHit,
  errCount,
  warnCount,
  logsOpen,
  onToggleLogs,
  onBooks,
  onSettings,
}: {
  connected: boolean
  /** 上下文占用：最近一次模型输入 / 容量（agent:usage 驱动；null=本轮尚无调用） */
  ctxInfo: { last: number; cap: number } | null
  /** 最新 usage 快照（弹窗：构成占比 / 缓存拆分） */
  ctxSnap: CtxSnap | null
  /** 会话级平均缓存命中率（0~1） */
  ctxAvgHit: number
  /** 当前保留日志中的错误 / 警告条数（实时驱动计数显示） */
  errCount: number
  warnCount: number
  logsOpen: boolean
  onToggleLogs: () => void
  onBooks: () => void
  onSettings: () => void
}): React.JSX.Element {
  const hasIssues = errCount + warnCount > 0
  // 上下文详情弹窗：点击「上下文」就近弹出，点外部 / Esc 关闭
  const [ctxOpen, setCtxOpen] = useState(false)
  const ctxWrapRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!ctxOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (ctxWrapRef.current && !ctxWrapRef.current.contains(e.target as Node)) setCtxOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxOpen])

  const bd = ctxSnap?.breakdown
  const bdRows: Array<{ label: string; v: number; cls: string }> = bd
    ? [
        { label: '消息', v: bd.messages, cls: 'seg-msg' },
        { label: '工具', v: bd.tools, cls: 'seg-tools' },
        { label: '技能', v: bd.skills, cls: 'seg-skills' },
        { label: '系统提示词', v: bd.system, cls: 'seg-sys' },
        { label: '其他', v: bd.other, cls: 'seg-other' },
      ]
    : []
  const bdTotal = bd ? Math.max(1, bd.messages + bd.tools + bd.skills + bd.system + bd.other) : 1
  const ctxPct = ctxInfo && ctxInfo.cap > 0 ? Math.min(100, Math.round((ctxInfo.last / ctxInfo.cap) * 100)) : 0
  return (
    <footer className="status-bar">
      <div className="sb-left">
        <span
          className={`sb-cell sb-conn ${connected ? 'sb-ok' : 'sb-bad'}`}
          title={connected ? 'WebSocket 已连接' : '连接断开，自动重连中'}
        >
          {connected ? '已连接' : '重连中…'}
        </span>
        {ctxInfo && (
          <span className="sb-ctx-wrap" ref={ctxWrapRef}>
            <button
              type="button"
              className={`sb-cell sb-btn sb-ctx${ctxOpen ? ' on' : ''}`}
              title="上下文容量与构成"
              aria-expanded={ctxOpen}
              onClick={() => setCtxOpen((v) => !v)}
            >
              上下文
              <span className="sb-ctx-track" aria-hidden>
                <i
                  style={{ width: `${ctxPct}%` }}
                  className={ctxPct >= 90 ? ' danger' : ctxPct >= 70 ? ' warn' : ''}
                />
              </span>
              {fmtWan(ctxInfo.last)}/{fmtWan(ctxInfo.cap)}
            </button>
            {ctxOpen && (
              <div className="ctx-pop" role="dialog" aria-label="上下文容量详情">
                <div className="ctx-pop-head">
                  <span className="ctx-pop-title">上下文容量</span>
                  <span className="ctx-pop-cap">
                    {ctxSnap
                      ? `${fmtWan(ctxSnap.lastInputTokens)}/${fmtWan(ctxSnap.capacity.tokens)}（${ctxPct}%）`
                      : `${fmtWan(ctxInfo?.last ?? 0)}/${fmtWan(ctxInfo?.cap ?? 0)}（${ctxPct}%）`}
                  </span>
                </div>
                <div className="ctx-pop-bar">
                  <i style={{ width: `${ctxPct}%` }} />
                </div>
                <div className="ctx-pop-rows">
                  {bdRows.map((r) => (
                    <div key={r.label} className="ctx-pop-row">
                      <span className={`ctx-dot ${r.cls}`} aria-hidden />
                      <span className="ctx-pop-label">{r.label}</span>
                      <span className="ctx-pop-val">{Math.round((r.v / bdTotal) * 100)}%</span>
                    </div>
                  ))}
                  {!ctxSnap && (
                    <div className="ctx-pop-note">发起对话后，这里会显示上下文构成（消息/工具/技能等）与缓存命中情况。</div>
                  )}
                </div>
                <div className="ctx-pop-hit">
                  <span>平均缓存命中率</span>
                  <b>{ctxSnap ? `${Math.round(ctxAvgHit * 100)}%` : '--'}</b>
                </div>
                <div className="ctx-pop-note ctx-pop-note-tail">
                  工具定义与技能目录是每次请求的固定携带内容，与当轮是否使用无关
                </div>
              </div>
            )}
          </span>
        )}
      </div>
      <div className="sb-right">
        <button
          type="button"
          className={`sb-cell sb-btn sb-logs${logsOpen ? ' on' : ''}${hasIssues ? ' has-issues' : ''}`}
          title="日志面板（错误 / 警告计数）"
          aria-label={`日志：${errCount} 个错误，${warnCount} 个警告`}
          onClick={onToggleLogs}
        >
          <span className={`sb-count${errCount > 0 ? ' bad' : ''}`}>
            <Icon name="x-circle" size={12} /> {errCount}
          </span>
          <span className={`sb-count${warnCount > 0 ? ' warn' : ''}`}>
            <Icon name="warning" size={12} /> {warnCount}
          </span>
        </button>
        <button type="button" className="sb-cell sb-btn" title="书架（切换 / 新建）" onClick={onBooks}>
          <Icon name="book-open" size={12} /> 书架
        </button>
        <button type="button" className="sb-cell sb-btn" title="设置中心（模型）" onClick={onSettings}>
          <Icon name="gear" size={12} /> 设置
        </button>
      </div>
    </footer>
  )
}
