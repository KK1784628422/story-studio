/** DirTreePicker：目录树选择器 —— 从初始根逐层展开目录，点击选择（不输入路径）。
 *  起始根：盘符根 / 空间目录 / 书目录所在 / 项目目录（由 /api/spaces/roots 提供）。 */
import { useCallback, useEffect, useState } from 'react'
import { fetchSpaceRoots, fetchSpaceTree, type SpaceRoot } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

interface Props {
  /** 选择动作文案（如「打开」/「创建到此」） */
  actionLabel: string
  disabled?: boolean
  onAction: (absPath: string) => void
}

export function DirTreePicker({ actionLabel, disabled, onAction }: Props): React.JSX.Element {
  const [roots, setRoots] = useState<SpaceRoot[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchSpaceRoots().then((r) => setRoots(r.roots)).catch(() => setRoots([]))
  }, [])

  const loadDirs = useCallback((abs: string) => {
    setError(null)
    setLoading(true)
    fetchSpaceTree(abs)
      .then((r) => {
        setCurrent(r.root)
        setDirs(r.dirs)
      })
      .catch(() => setError('目录读取失败'))
      .finally(() => setLoading(false))
  }, [])

  const enter = (name: string) => {
    if (!current) return
    loadDirs(`${current}/${name}`)
  }

  return (
    <div className="dtp">
      {/* 初始根 */}
      <div className="dtp-roots">
        {roots.map((r) => (
          <button
            key={r.path}
            type="button"
            className={`dtp-root${current === r.path ? ' active' : ''}`}
            onClick={() => loadDirs(r.path)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* 当前路径 + 面包屑 */}
      {current && (
        <div className="dtp-crumb">
          <button type="button" className="dtp-crumb-btn" onClick={() => loadDirs(current)} title="刷新">
            {current}
          </button>
          {error && <span className="dtp-error">{error}</span>}
        </div>
      )}

      {/* 操作当前目录本身（新建时即为父目录；打开时选已被展开的目录） */}
      {current && (
        <div className="dtp-actbar">
          <span className="dtp-actpath">{current}</span>
          <button type="button" className="dtp-pick" disabled={disabled} onClick={() => onAction(current)}>
            {actionLabel}（当前目录）
          </button>
        </div>
      )}

      {/* 一层子目录 */}
      <div className="dtp-list">
        {loading && <div className="dtp-empty">读取中…</div>}
        {!loading && !current && <div className="dtp-empty">先选择一个起始位置</div>}
        {!loading && current && dirs.length === 0 && <div className="dtp-empty">（无子目录）</div>}
        {!loading &&
          dirs.map((d) => (
            <div key={d} className="dtp-row">
              <button type="button" className="dtp-dir" onClick={() => enter(d)}>
                <Icon name="folder" size={13} /> {d}
              </button>
              <button
                type="button"
                className="dtp-pick"
                disabled={disabled}
                onClick={() => onAction(current ? `${current}/${d}` : '')}
              >
                {actionLabel}
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}