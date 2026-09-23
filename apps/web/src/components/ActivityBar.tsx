/** 活动栏（Trae 风格最左窄条）：品牌/折叠开关 + 七模式切换 + 书架/资源管理器/指南/设置（调试日志已迁至底部状态栏） */
import { MODES, type ModeId } from '@story-studio/shared'
import { Icon } from './Icon.tsx'

export function ActivityBar({
  mode,
  onMode,
  sideCollapsed,
  onToggleSide,
  explorerOpen,
  onToggleExplorer,
  onBooks,
  onGuide,
  onSettings,
}: {
  mode: ModeId
  onMode: (m: ModeId) => void
  sideCollapsed: boolean
  onToggleSide: () => void
  explorerOpen: boolean
  onToggleExplorer: () => void
  onBooks: () => void
  onGuide: () => void
  onSettings: () => void
}): React.JSX.Element {
  return (
    <nav className="activitybar">
      <button
        type="button"
        className="ab-brand"
        title={sideCollapsed ? '展开侧栏' : '折叠侧栏'}
        onClick={onToggleSide}
      >
        {sideCollapsed ? '展开' : '折叠'}
      </button>
      <div className="ab-group ab-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`ab-btn${mode === m.id ? ' active' : ''}`}
            title={`${m.label} — ${m.desc}`}
            onClick={() => onMode(m.id)}
          >
            <Icon name={m.icon} size={17} />
          </button>
        ))}
      </div>
      <div className="ab-group ab-bottom">
        <button type="button" className={`ab-btn${explorerOpen ? ' on' : ''}`} title="资源管理器" onClick={onToggleExplorer}>
          <Icon name="folder" size={17} />
        </button>
        <button type="button" className="ab-btn" title="书架切换" onClick={onBooks}>
          <Icon name="book-open" size={17} />
        </button>
        <button type="button" className="ab-btn" title="创作指南（教学 + 分步指引）" onClick={onGuide}>
          <Icon name="guide" size={17} />
        </button>
        <button type="button" className="ab-btn" title="模型设置" onClick={onSettings}>
          <Icon name="gear" size={17} />
        </button>
      </div>
    </nav>
  )
}
