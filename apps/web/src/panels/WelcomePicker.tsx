/** WelcomePicker：启动引导 —— 新建小说 / 打开小说文件夹 / 最近创作记录（5 条）。
 *  历史会话与最近记录统一存于项目内空间目录（.story-spaces/），书目录可在任意位置（含项目外）。 */
import { useState } from 'react'
import type { SpaceBook } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { DirTreePicker } from './DirTreePicker.tsx'

interface Props {
  books: SpaceBook[]
  busy: boolean
  error: string | null
  onCreate: (parentPath: string, title: string) => void
  onOpen: (path: string) => void
}

type Dialog = 'none' | 'create' | 'open'

export function WelcomePicker({ books, busy, error, onCreate, onOpen }: Props): React.JSX.Element {
  const [dialog, setDialog] = useState<Dialog>('none')
  const [title, setTitle] = useState('')

  const submitCreate = (parentPath: string) => {
    const t = title.trim()
    if (t) onCreate(parentPath, t)
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">OpenNovel</div>
        <p className="welcome-sub">
          <span className="welcome-caption">STORY STUDIO · AI NOVEL ATELIER</span>
          为网文作者打造的 AI 创作工作台——扫榜拆文、设定追踪、日更成书。
          历史会话统一保存在空间目录，书目录可以在任何位置（含项目之外）。
        </p>

        {error && <div className="welcome-error">{error}</div>}

        <div className="welcome-actions">
          <button
            type="button"
            className="welcome-action primary"
            disabled={busy}
            onClick={() => {
              setTitle('')
              setDialog('create')
            }}
          >
            <Icon name="file-pen" size={20} />
            新建小说
            <span className="welcome-action-desc">从零开一本书：书名 + 目录，自动生成工程骨架</span>
          </button>
          <button type="button" className="welcome-action" disabled={busy} onClick={() => setDialog('open')}>
            <Icon name="folder-open" size={20} />
            打开小说文件夹
            <span className="welcome-action-desc">选择已有书工程（含正文 / 大纲 / 设定 / 追踪）继续创作</span>
          </button>
        </div>

        <div className="welcome-section-title">最近创作</div>
        {books.length === 0 ? (
          <div className="welcome-empty">暂无记录——新建一本书，或打开已有小说文件夹。</div>
        ) : (
          <div className="welcome-books">
            {books.slice(0, 5).map((b) => (
              <button key={b.path} type="button" className="welcome-book" disabled={busy} onClick={() => onOpen(b.path)}>
                <span className="welcome-book-title"><Icon name="folder" size={14} /> {b.title}</span>
                <span className="welcome-meta">{b.path}</span>
              </button>
            ))}
          </div>
        )}

        {dialog !== 'none' && (
          <div
            className="welcome-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDialog('none')
            }}
          >
            <div className="welcome-dialog">
              <div className="welcome-dialog-title">
                <span>{dialog === 'create' ? '新建小说' : '打开小说文件夹'}</span>
                <button type="button" className="btn-ghost" onClick={() => setDialog('none')}>
                  关闭
                </button>
              </div>
              <p className="welcome-dialog-sub">
                {dialog === 'create'
                  ? '输入书名，在下方目录中选定一个父目录（点「创建到此」）。'
                  : '在下方目录中依次展开，找到小说目录后点「打开」。'}
              </p>
              {dialog === 'create' && (
                <input
                  className="welcome-input"
                  placeholder="书名（将作为目录名）"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  spellCheck={false}
                />
              )}
              <DirTreePicker
                disabled={busy}
                actionLabel={dialog === 'create' ? '创建到此' : '打开'}
                onAction={dialog === 'create' ? submitCreate : (p) => onOpen(p)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}