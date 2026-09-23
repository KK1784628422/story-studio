/**
 * 文档工作台（可视化栏内嵌编辑，替代旧 doc-modal 弹窗）：
 * 大纲/设定 可编辑保存，追踪派生视图只读；查看/编辑双模式。
 * - 非正文章节文档（大纲/设定/其他 .md）：编辑模式为 Quill 富文本（WYSIWYG：字体/字号/文字颜色/背景色/
 *   对齐/列表/引用/链接/图片/代码块），保存时 turndown 序列化回 Markdown（颜色/字号等以内嵌 HTML 保留，
 *   markdown-it 以 html 渲染还原）。
 * - 正文章节文档（正文/第NNN章_*.md）与 JSON：保持 Markdown textarea（保真创作，不破坏章节门禁/Agent 链路）。
 * - 保存分流：资源管理器打开的文件（绝对路径）→ 通用 /api/file；资料库卡片（相对路径）→ /api/doc。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import Quill from 'quill'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import 'quill/dist/quill.snow.css'
import type { DocCard } from '@story-studio/shared'
import { fetchDoc, saveDoc, saveFile } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { prefixMd, wrapMd } from '../reader/mdTools.ts'

const md = new MarkdownIt({ html: true, linkify: true, breaks: false })
const DOC_FONT_KEY = 'ss.doc.font'

/* ---------- 富文本（Quill snow）配置 ---------- */
// 字体族白名单（工具栏「字体」下拉；首项默认）
const Font = Quill.import('formats/font') as { whitelist?: string[] }
Font.whitelist = ['sans-serif', 'serif', 'monospace', '楷体', '黑体', '仿宋', '微软雅黑']
Quill.register({ 'formats/font': Font } as never, true)
// 字号白名单（工具栏「字号」下拉，px 直接作用于行内样式）
const Size = Quill.import('attributors/style/size') as { whitelist?: string[] }
Size.whitelist = ['12px', '14px', '16px', '18px', '20px', '24px']
Quill.register({ 'attributors/style/size': Size } as never, true)

const TOOLBAR = [
  [{ header: [1, 2, 3, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ font: [] }, { size: [] }],
  [{ align: [false, 'center', 'right', 'justify'] }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['blockquote', 'link', 'image', 'code-block', 'clean'],
]

// HTML → Markdown 序列化（富文本保存）：keep span 保留颜色/字号等内嵌样式；gfm 提供表格/删除线规则
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.use(gfm)
turndown.keep(['span'])

/** markdown 是否含表格（渲染后含 <table>）——含表格文档回退 Markdown 编辑，防富文本破坏表格结构 */
const containsTable = (text: string): boolean => {
  try {
    return md.render(text).includes('<table')
  } catch {
    return false
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 绝对路径判断：资源管理器打开的文件（相对路径 = 资料库卡片） */
const isAbsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]|^[\\/]/.test(p)

export function DocWorkbench({
  card,
  preload,
  onClose,
}: {
  card: DocCard | null
  /** 资源管理器文件直读内容：有值时跳过 fetchDoc（不再强制只读） */
  preload?: string
  onClose: () => void
}): React.JSX.Element {
  const [html, setHtml] = useState('')
  const [raw, setRaw] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [docFont, setDocFont] = useState(() => {
    const n = Number(localStorage.getItem(DOC_FONT_KEY))
    return Number.isFinite(n) ? Math.max(13, Math.min(24, n)) : 16
  })
  /** 作者手工标记「此版负责」：保存时对正文文件登记免检（仅正文可勾） */
  const [markApproved, setMarkApproved] = useState(false)
  /** 当前卡片是否为 正文/*.md（只有正文享受作者免检） */
  const isProse = useMemo(() => /(^|\/)正文\//.test(card?.path.replaceAll('\\', '/') ?? ''), [card?.path])
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const richRootRef = useRef<HTMLDivElement | null>(null)
  const quillRef = useRef<Quill | null>(null)

  // 富文本：非正文章节、非 JSON 文档默认启用；进入编辑时若文档含表格则回退 Markdown（防破坏表格结构）
  const [rich, setRich] = useState(false)
  useEffect(() => {
    setRich(card ? !card.path.includes('正文') && !/\.json$/i.test(card.path) : false)
  }, [card])
  const readOnly = card ? (card.readOnly ?? card.path.startsWith('追踪/')) : false

  useEffect(() => {
    if (!card) return
    setLoading(true)
    setError('')
    setEditing(false)
    setMsg('')
    // 资源管理器直读内容：跳过资料库通道，直接渲染
    if (preload !== undefined) {
      setRaw(preload)
      setDraft(preload)
      setHtml(md.render(preload))
      setLoading(false)
      return
    }
    fetchDoc(card.path)
      .then((text) => {
        setRaw(text)
        setDraft(text)
        setHtml(card.kind === 'json' ? `<pre>${escapeHtml(text)}</pre>` : md.render(text))
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(String(e.message || e))
        setLoading(false)
      })
  }, [card, preload])

  useEffect(() => {
    localStorage.setItem(DOC_FONT_KEY, String(docFont))
  }, [docFont])

  // 进入富文本编辑 → 初始化 Quill 并注入当前 markdown 渲染；退出编辑/切文件 → 销毁
  // Quill 2 无 destroy API（事件全绑在 editor root 上，随 React 卸载 DOM 自动回收）；
  // cleanup 仅还原容器并断开引用——防止 StrictMode 双跑时对已初始化容器二次 new Quill
  useEffect(() => {
    if (!editing || !rich || readOnly || !richRootRef.current) return
    const q = new Quill(richRootRef.current, {
      theme: 'snow',
      modules: { toolbar: TOOLBAR, clipboard: { matchVisual: false } },
    })
    q.root.innerHTML = md.render(draft)
    quillRef.current = q
    return () => {
      const root = richRootRef.current
      if (root) {
        root.className = 'rich-editor'
        root.innerHTML = ''
      }
      quillRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, rich, readOnly])

  const applyEdit = (res: { text: string; start: number; end: number }) => {
    setDraft(res.text)
    setTimeout(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(res.start, res.end)
    })
  }

  const wrap = (before: string, after = before, placeholder = '文本') => {
    const el = taRef.current
    if (!el) return
    applyEdit(wrapMd(el.value, el.selectionStart, el.selectionEnd, before, after, placeholder))
  }
  const prefix = (p: string) => {
    const el = taRef.current
    if (!el) return
    applyEdit(prefixMd(el.value, el.selectionStart, el.selectionEnd, p))
  }

  const save = async () => {
    if (!card) return
    // 富文本模式：从 Quill DOM 序列化回 Markdown（保持颜色/字号内嵌 HTML）
    const out = editing && rich && quillRef.current ? turndown.turndown(quillRef.current.root.innerHTML) : draft
    setSaving(true)
    setMsg('保存中…')
    try {
      // 资源管理器打开的文件（绝对路径）走通用通道；资料库卡片（相对路径）走 /api/doc
      if (isAbsPath(card.path)) await saveFile(card.path, out, { authorApproved: markApproved })
      else await saveDoc(card.path, out)
      setRaw(out)
      setDraft(out)
      setHtml(card.kind === 'json' ? `<pre>${escapeHtml(out)}</pre>` : md.render(out))
      setEditing(false)
      setMarkApproved(false)
      setMsg(markApproved ? '已保存 · 此版已标记「作者已确认」免检' : '已保存')
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const closeOnEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )
  useEffect(() => {
    window.addEventListener('keydown', closeOnEsc)
    return () => window.removeEventListener('keydown', closeOnEsc)
  }, [closeOnEsc])

  if (!card) {
    return (
      <div className="doc-workbench">
        <div className="dw-empty">
          <Icon name="pencil" size={22} />
          <p>从「可视化 → 资料」选择一张卡片开始编辑；Esc 或「返回资料」退出。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="doc-workbench">
      <div className="dw-head">
        <button type="button" className="ed-btn" onClick={onClose} title="返回资料卡墙（Esc）">
          ← 返回资料
        </button>
        <div className="dw-title">
          <b>{card.title}</b>
          <span className="doc-modal-file">{card.path}</span>
        </div>
        {!readOnly ? (
          !editing ? (
            <button
              type="button"
              className="ed-btn primary"
              onClick={() => {
                setDraft(raw)
                setEditing(true)
                setMsg('')
                // 含表格文档回退 Markdown 编辑（富文本无法结构化编辑表格，避免序列化破坏）
                if (rich && containsTable(raw)) setRich(false)
              }}
            >
              <Icon name="pencil" size={12} /> 编辑
            </button>
          ) : (
            <div className="doc-edit-actions">
              {isProse && (
                <label className="dw-approved" title="保存后该版正文标记「作者已确认」：跳过门禁/质检；此后 AI 再改动会恢复门禁">
                  <input
                    type="checkbox"
                    checked={markApproved}
                    onChange={(e) => setMarkApproved(e.target.checked)}
                  />
                  作者已修改 · 标记免检
                </label>
              )}
              <button type="button" className="ed-btn primary" onClick={() => void save()} disabled={saving}>
                <Icon name="save-floppy" size={12} /> {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="ed-btn" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          )
        ) : (
          <span className="doc-readonly-badge">只读 · 派生视图</span>
        )}
      </div>

      {loading && <div className="cards-loading">正在加载文档…</div>}
      {error && <div className="reader-error">{error}</div>}
      {!loading && !error && !editing && (
        <div className="dw-content">
          <article
            className="markdown-body"
            style={{ fontSize: `${docFont}px` }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
      {!loading && !error && editing && rich && (
        <div className="dw-edit dw-edit-rich">
          <div ref={richRootRef} className="rich-editor" />
        </div>
      )}
      {!loading && !error && editing && !rich && (
        <div className="dw-edit">
          <div className="ed-toolbar">
            <button className="ed-tb" title="标题" onClick={() => prefix('# ')}>
              H
            </button>
            <button className="ed-tb" title="加粗" onClick={() => wrap('**')}>
              B
            </button>
            <button className="ed-tb" title="斜体" onClick={() => wrap('*')}>
              I
            </button>
            <button className="ed-tb" title="引用" onClick={() => prefix('> ')}>
              ❝
            </button>
            <button className="ed-tb" title="无序列表" onClick={() => prefix('- ')}>
              ≡
            </button>
            <button className="ed-tb" title="有序列表" onClick={() => prefix('1. ')}>
              1.
            </button>
            <button className="ed-tb" title="链接" onClick={() => wrap('[', '](https://)', '链接文字')}>
              🔗
            </button>
            <button className="ed-tb" title="代码" onClick={() => wrap('`')}>
              {'</>'}
            </button>
            <span className="ed-toolbar-spacer" />
            <div className="ed-font">
              <button className="fs-btn" disabled={docFont <= 13} onClick={() => setDocFont((f) => Math.max(13, f - 1))}>
                －
              </button>
              <span className="ed-font-val">{docFont}px</span>
              <button className="fs-btn" disabled={docFont >= 24} onClick={() => setDocFont((f) => Math.min(24, f + 1))}>
                ＋
              </button>
            </div>
          </div>
          <textarea
            ref={taRef}
            className="editor-textarea doc-modal-textarea"
            style={{ fontSize: `${docFont}px` }}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      {msg && <div className="doc-msg">{msg}</div>}
    </div>
  )
}
