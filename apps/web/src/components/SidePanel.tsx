/** 侧面板（活动栏展开态）：模式列表 + 历史会话（当前会话高亮） */
import { MODES, modeMeta, type ModeId } from '@story-studio/shared'
import { Icon } from './Icon.tsx'

export interface SessionBrief {
  id: string
  title: string
  mode: string
  updatedAt: string
}

export function SidePanel({
  mode,
  onMode,
  sessions,
  currentSessionId,
  onLoadSession,
  collapsed = false,
  onNewSession,
}: {
  mode: ModeId
  onMode: (m: ModeId) => void
  sessions: SessionBrief[]
  currentSessionId: string
  onLoadSession: (id: string) => void
  /** 收起态：宽度动画收 0（印章按钮可再展开） */
  collapsed?: boolean
  /** 「＋ 新会话」按钮（原顶栏入口移到这里） */
  onNewSession?: () => void
}): React.JSX.Element {
  const meta = modeMeta(mode)
  return (
    <aside className={`sidepanel${collapsed ? ' collapsed' : ''}`}>
      <div className="sp-head">
        <span className="sp-title">{meta.label}</span>
        <span className="sp-sub">{meta.desc}</span>
      </div>
      <div className="sp-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`sp-mode-item${mode === m.id ? ' active' : ''}`}
            onClick={() => onMode(m.id)}
            title={m.desc}
          >
            <Icon name={m.icon} size={15} />
            <span className="sp-mode-label">{m.label}</span>
          </button>
        ))}
      </div>
      <div className="sp-divider" />
      {onNewSession && (
        <button type="button" className="sp-new-session" title="开启新会话（Ctrl+Alt+N）" onClick={onNewSession}>
          ＋ 新会话
        </button>
      )}
      <div className="sp-sessions-title">历史会话</div>
      <div className="sp-sessions">
        {sessions.length === 0 && <div className="session-empty">暂无历史会话</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`session-item${s.id === currentSessionId ? ' current' : ''}`}
            onClick={() => onLoadSession(s.id)}
          >
            <span className="session-title">{s.title}</span>
            <span className="session-meta">
              <Icon name={modeMeta(s.mode as ModeId).icon} size={12} /> {s.updatedAt.slice(5, 16).replace('T', ' ')}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
