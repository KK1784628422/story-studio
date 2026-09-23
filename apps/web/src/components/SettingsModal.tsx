/**
 * 统一设置中心外壳：模型 / 书架 / 调试日志 三弹窗合一。
 * 左侧页签导航（金色滑动指示条）+ 右侧内容区（切页横向滑入）；
 * 遮罩点击 / Esc / 关闭钮退出；各页签内容由 App 传入（状态留在各自归属处）。
 * 动画尊重 prefers-reduced-motion。
 */
import { useEffect } from 'react'
import { Icon } from './Icon.tsx'

export type SettingsTabId = 'models' | 'books' | 'appearance' | 'usage' | 'music' | 'fanfic'

export interface SettingsTab {
  id: SettingsTabId
  label: string
  icon: string
  desc?: string
  content: React.ReactNode
}

/** 与 CSS .settings-hub-tab 高度保持一致（指示条按此步进滑动） */
const TAB_H = 58

export function SettingsModal({
  tabs,
  active,
  onTab,
  onClose,
}: {
  tabs: SettingsTab[]
  active: SettingsTabId
  onTab: (id: SettingsTabId) => void
  onClose: () => void
}): React.JSX.Element {
  // Esc 关闭（focus 在任何页签内容输入框内同样生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0]
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeTab.id),
  )

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-hub" role="dialog" aria-modal="true" aria-label="设置中心">
        <aside className="settings-hub-nav">
          <div className="settings-hub-brand">
            <Icon name="gear" size={15} />
            <span>设置中心</span>
          </div>
          <div className="settings-hub-tabs">
            <span
              className="settings-hub-indicator"
              style={{ transform: `translateY(${activeIndex * TAB_H}px)`, opacity: activeIndex >= 0 ? 1 : 0 }}
              aria-hidden
            />
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`settings-hub-tab${t.id === active ? ' on' : ''}`}
                aria-current={t.id === active ? 'page' : undefined}
                onClick={() => onTab(t.id)}
              >
                <Icon name={t.icon} size={15} />
                <span className="settings-hub-tab-text">
                  <b>{t.label}</b>
                  {t.desc && <i>{t.desc}</i>}
                </span>
              </button>
            ))}
          </div>
        </aside>
        {/* key=页签 id：切页重挂内容区，触发滑入动画（表单草稿不保留，与旧弹窗开合行为一致） */}
        <section className="settings-hub-main" key={activeTab.id}>
          <div className="settings-hub-head">
            <span className="settings-hub-title">
              <Icon name={activeTab.icon} size={14} /> {activeTab.label}
            </span>
            <button type="button" className="drawer-close" title="关闭（Esc）" aria-label="关闭设置" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="settings-hub-body">{activeTab.content}</div>
        </section>
      </div>
    </div>
  )
}
