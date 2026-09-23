/** 目录抽屉（novel-reader 移植） */
import type { ChapterBrief } from '@story-studio/shared'

interface Props {
  open: boolean
  chapters: ChapterBrief[]
  current: number
  onSelect: (index: number) => void
  onClose: () => void
}

export function TocDrawer({ open, chapters, current, onSelect, onClose }: Props) {
  return (
    <>
      <div
        className={`drawer-mask${open ? ' open' : ''}`}
        onClick={onClose}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      />
      <div className={`drawer toc-drawer${open ? ' open' : ''}`}>
        <div className="drawer-head">
          <h2>目录</h2>
          <button className="drawer-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="toc-list">
          {chapters.map((c) => (
            <button
              key={c.index}
              className={`toc-item${c.index === current ? ' active' : ''}`}
              onClick={() => onSelect(c.index)}
            >
              <span className="toc-no">{c.index}</span>
              <span className="toc-title">{c.title}</span>
              {c.index === current && <span className="toc-cur">当前</span>}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
