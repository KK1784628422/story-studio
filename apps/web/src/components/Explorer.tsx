/** 文件资源管理器（最右栏）：书工作区文件树（惰性展开），文件点击 → 只读预览；
 *  右键菜单：打开文件资源管理器 / 添加到对话 / 复制路径 / 删除（弹确认） */
import { useEffect, useRef, useState } from 'react'
import { deleteWorkspaceFile, fetchSpaceTree, revealInExplorer } from '../api.ts'
import type { WsEvent } from '@story-studio/shared'
import { Icon } from './Icon.tsx'

interface Props {
  /** 书工作区绝对路径（变化即整树重建） */
  workspace: string
  bookTitle: string
  onOpenFile: (absPath: string) => void
  /** 正文章节文件「手机阅读」：解析章号后跳转可视化阅读器定位 */
  onReadChapter: (absPath: string) => void
  /** 头部 » 按钮收起整个资源管理器 */
  onCollapse: () => void
  /** 右键「添加到对话」：把 @路径 引用插入聊天输入框（App 层经 ChatPanel 透传 Composer） */
  onInsertToChat: (absPath: string) => void
  /** WS 事件（Agent 写入/门禁/追踪更新触发文件树热刷新） */
  wsEvent?: WsEvent | null
}

type Tree = { dirs: string[]; files: string[] }
const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}\\${name}`
const parentDir = (p: string) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))

/** 正文章节文件：文件名 第NNN章*.md（正文目录命名约定；大纲里的 卷纲/细纲 等前缀不匹配） */
const CHAPTER_FILE_RE = /^第\s*0*\d+\s*章/i
const isChapterFile = (path: string): boolean => {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  return name.endsWith('.md') && CHAPTER_FILE_RE.test(name)
}

/** 热刷新防抖：Agent 落盘是连续流（一次写作可触发几十个 file:changed），
 *  逐事件清缓存重拉会让资源管理器整树闪烁卡顿——静默 900ms 后合并为一次刷新 */
const REFRESH_DEBOUNCE_MS = 900

/** 右键菜单状态（fixed 定位；isDir 区分目录项——「添加到对话」仅文件） */
interface CtxMenu {
  x: number
  y: number
  path: string
  name: string
  isDir: boolean
}

export function Explorer({ workspace, bookTitle, onOpenFile, onReadChapter, onCollapse, onInsertToChat, wsEvent }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([workspace]))
  const [cache, setCache] = useState<Map<string, Tree>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  /** 文件热刷新信号：防抖到期后自增，触发已展开目录重拉 */
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 右键菜单 / 删除确认
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  /** 删除确认目标（null = 关闭）；deleting 标记请求进行中 */
  const [confirmDel, setConfirmDel] = useState<CtxMenu | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef(0)
  const showHint = (msg: string) => {
    setHint(msg)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHint(null), 3000)
  }

  useEffect(() => {
    setExpanded(new Set([workspace]))
    setCache(new Map())
    setError(null)
  }, [workspace])

  // Agent 落盘/门禁/追踪更新 → 防抖后热刷新文件树（无需手动重开资源管理器）
  useEffect(() => {
    if (!wsEvent) return
    const ev = wsEvent
    if (
      ev.type === 'file:changed' ||
      ev.type === 'gate:result' ||
      ev.type === 'tracking:updated' ||
      ev.type === 'book:switched'
    ) {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => setRefreshTick((n) => n + 1), REFRESH_DEBOUNCE_MS)
    }
  }, [wsEvent])

  // 卸载时清掉未触发的防抖定时器
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      window.clearTimeout(hintTimer.current)
    }
  }, [])

  // 热刷新：清掉已展开目录的缓存，让拉取 effect 重取（保持展开态）
  useEffect(() => {
    if (refreshTick === 0) return
    setCache((prev) => {
      const next = new Map(prev)
      for (const dir of expanded) next.delete(dir)
      return next
    })
  }, [refreshTick, expanded])

  // 展开集合中出现未加载层 → 拉取
  useEffect(() => {
    let alive = true
    for (const dir of expanded) {
      if (cache.has(dir)) continue
      void fetchSpaceTree(dir)
        .then((r) => {
          if (!alive) return
          setCache((prev) => new Map(prev).set(dir, { dirs: r.dirs ?? [], files: r.files ?? [] }))
        })
        .catch(() => {
          if (alive) setError('部分目录读取失败')
        })
    }
    return () => {
      alive = false
    }
  }, [expanded, cache])

  // 右键菜单关闭：点击任意处 / Escape / 滚动树
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  // ---------- 右键动作 ----------
  const openMenu = (e: React.MouseEvent, path: string, name: string, isDir: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, path, name, isDir })
  }

  const doReveal = (m: CtxMenu) => {
    revealInExplorer(m.path)
      .then((r) => {
        if (!r.ok) showHint(r.error ?? '打开资源管理器失败')
      })
      .catch(() => showHint('打开资源管理器失败（服务不可达）'))
  }

  const doCopyPath = async (m: CtxMenu) => {
    try {
      await navigator.clipboard.writeText(m.path)
      showHint('路径已复制')
    } catch {
      showHint('复制失败（剪贴板不可用）')
    }
  }

  const doDelete = async (m: CtxMenu) => {
    setDeleting(true)
    setDelError(null)
    try {
      const r = await deleteWorkspaceFile(m.path)
      if (!r.ok) {
        setDelError(r.error ?? '删除失败')
        return
      }
      // 刷新父目录（清缓存即触发已展开层重拉）；若删的是已展开目录本身也一并收起
      setCache((prev) => {
        const next = new Map(prev)
        next.delete(parentDir(m.path))
        return next
      })
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const d of next) if (d === m.path || d.startsWith(`${m.path}\\`)) next.delete(d)
        return next
      })
      setConfirmDel(null)
      showHint(`已删除：${m.name}`)
    } catch (err) {
      setDelError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const menuItems = (m: CtxMenu) => {
    const items: Array<{ key: string; label: string; icon: string; danger?: boolean; run: () => void }> = [
      { key: 'reveal', label: '打开文件资源管理器', icon: 'folder-open', run: () => void doReveal(m) },
      ...(m.isDir || !isChapterFile(m.path)
        ? []
        : [{ key: 'read', label: '手机可视化阅读', icon: 'book-open', run: () => onReadChapter(m.path) }]),
      ...(m.isDir
        ? []
        : [{ key: 'chat', label: '添加到对话', icon: 'file-fetch', run: () => onInsertToChat(m.path) }]),
      { key: 'copy', label: '复制路径', icon: 'clipboard-list', run: () => void doCopyPath(m) },
      { key: 'delete', label: m.isDir ? '删除（含目录内容）' : '删除', icon: 'x-circle', danger: true, run: () => setConfirmDel(m) },
    ]
    return items
  }

  const renderDir = (label: string, path: string, depth: number) => {
    const open = expanded.has(path)
    const kids = open ? cache.get(path) : undefined
    return (
      <div key={path}>
        <button
          type="button"
          className="fx-row fx-dir"
          style={{ paddingLeft: 6 + depth * 13 }}
          title={path}
          onClick={() => toggle(path)}
          onContextMenu={(e) => openMenu(e, path, label, true)}
        >
          <span className={`fx-caret${open ? ' open' : ''}`}>▸</span>
          <Icon name="folder" size={13} />
          <span className="fx-label">{label}</span>
        </button>
        {open && kids && (
          <>
            {/* 空目录占位：展开后无子项时给一行反馈，避免「点了没反应」 */}
            {kids.dirs.length === 0 && kids.files.length === 0 && (
              <div className="fx-empty" style={{ paddingLeft: 6 + (depth + 1) * 13 + 4 }}>
                （空目录）
              </div>
            )}
            {kids.dirs.map((d) => renderDir(d, joinPath(path, d), depth + 1))}
            {kids.files.map((f) => {
              const full = joinPath(path, f)
              return (
                <button
                  key={f}
                  type="button"
                  className="fx-row fx-file"
                  style={{ paddingLeft: 6 + (depth + 1) * 13 + 4 }}
                  title={full}
                  draggable
                  onDragStart={(e) => {
                    // 拖拽到输入栏 = @路径引用（ChatComposer 的 drop 接收）
                    e.dataTransfer.setData('text/x-story-file', full)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onOpenFile(full)}
                  onContextMenu={(e) => openMenu(e, full, f, false)}
                >
                  <Icon name="file-text" size={13} />
                  <span className="fx-label">{f}</span>
                  {isChapterFile(full) && (
                    <span
                      className="fx-read"
                      title="手机可视化阅读"
                      onClick={(e) => {
                        e.stopPropagation()
                        onReadChapter(full)
                      }}
                    >
                      <Icon name="book-open" size={13} />
                    </span>
                  )}
                </button>
              )
            })}
          </>
        )}
      </div>
    )
  }

  return (
    <aside className="explorer">
      <div className="fx-head">
        <span className="fx-title">资源管理器</span>
        <span className="fx-book" title={workspace}>{bookTitle}</span>
        <button type="button" className="fx-collapse" title="收起资源管理器" onClick={onCollapse}>
          收起 »
        </button>
      </div>
      <div className="fx-tree">
        {error && <div className="fx-error">{error}</div>}
        {hint && <div className="fx-toast">{hint}</div>}
        {renderDir(bookTitle || '工作区', workspace, 0)}
      </div>

      {/* 右键菜单（fixed；面板宽度约 260，超出视口右/下边缘时回移） */}
      {menu && (
        <div
          className="fx-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 200) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="fx-menu-title" title={menu.path}>{menu.name}</div>
          {menuItems(menu).map((it) => (
            <button
              key={it.key}
              type="button"
              className={`fx-menu-item${it.danger ? ' danger' : ''}`}
              onClick={() => {
                setMenu(null)
                it.run()
              }}
            >
              <Icon name={it.icon} size={13} />
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 删除确认弹窗 */}
      {confirmDel && (
        <div className="fx-confirm-mask" onClick={() => !deleting && setConfirmDel(null)}>
          <div className="fx-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="fx-confirm-title">
              <Icon name="warning" size={15} />
              确认删除{confirmDel.isDir ? '目录' : '文件'}
            </div>
            <div className="fx-confirm-path" title={confirmDel.path}>{confirmDel.path}</div>
            {confirmDel.isDir && <div className="fx-confirm-warn">目录内的全部内容将一并删除，不可恢复。</div>}
            {delError && <div className="fx-confirm-err">{delError}</div>}
            <div className="fx-confirm-actions">
              <button type="button" className="btn-ghost" disabled={deleting} onClick={() => setConfirmDel(null)}>
                取消
              </button>
              <button type="button" className="fx-confirm-delete" disabled={deleting} onClick={() => void doDelete(confirmDel)}>
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
