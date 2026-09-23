/**
 * 章节编辑器（novel-reader EditorPanel 移植 + Story Studio 适配）：
 * 跟随阅读器当前章节；工具栏编辑/预览/字号；同步保存（mtime 冲突检测）；
 * 人工门禁反馈（blocking 只提示不强拦）；右键手机屏文字锚点定位。
 */
import { useEffect, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import type { GateReport } from '@story-studio/shared'
import { fetchChapter, saveChapter } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

interface Finding {
  line: number
  column: number
  severity: string
  type: string
  message: string
}

/** 解析检测脚本 output 中每一条 `file:line:column: [severity] type: message` 行，得到可跳转的定位信息 */
const parseFindings = (output: string): Finding[] => {
  const re = /:(\d+):(\d+):\s*\[(\w+)\]\s*([a-z0-9-]+):\s*(.*)$/
  const out: Finding[] = []
  for (const raw of output.split('\n')) {
    const m = raw.match(re)
    if (!m) continue
    out.push({ line: Number(m[1]), column: Number(m[2]), severity: m[3], type: m[4], message: m[5].trim() })
  }
  return out
}

interface Props {
  chapterIdx: number
  /** 同步成功后通知父级刷新阅读器 */
  onSynced: () => void
  /** 手机屏右键产生的文字锚点；nonce 变化时定位到该文字 */
  jumpAnchor?: { anchor?: string; nonce: number } | null
}

type Mode = 'edit' | 'preview'

const EDITOR_FONT_KEY = 'ss.editor.font'
const EDITOR_FONT_DEFAULT = 16

export function EditorPanel({ chapterIdx, onSynced, jumpAnchor }: Props) {
  const [text, setText] = useState('')
  const [lastSaved, setLastSaved] = useState('')
  const [mtime, setMtime] = useState(0)
  const [mode, setMode] = useState<Mode>('edit')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState('')
  const [gate, setGate] = useState<{ passed: boolean; report: GateReport } | null>(null)
  const [editorFont, setEditorFont] = useState<number>(() => {
    const n = Number(localStorage.getItem(EDITOR_FONT_KEY))
    return Number.isFinite(n) && n >= 12 && n <= 30 ? n : EDITOR_FONT_DEFAULT
  })
  const historyRef = useRef<string[]>([])
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const dirty = !loading && text !== lastSaved

  // 切换章节时载入该章 markdown
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setStatus('')
    setGate(null)
    fetchChapter(chapterIdx)
      .then((c) => {
        if (cancelled) return
        setText(c.markdown)
        setLastSaved(c.markdown)
        setMtime(c.mtime)
        historyRef.current = []
        setStatus('已加载')
        setLoading(false)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setStatus(`加载失败：${e.message}`)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chapterIdx])

  useEffect(() => {
    localStorage.setItem(EDITOR_FONT_KEY, String(editorFont))
  }, [editorFont])

  const sync = async (content: string) => {
    setSyncing(true)
    setStatus('同步中…')
    setGate(null)
    try {
      const r = await saveChapter(chapterIdx, content, mtime)
      setLastSaved(content)
      setMtime(r.mtime)
      setGate(r.gate)
      setStatus(r.gate.passed ? '已同步到手机' : '已同步（有质检提示，见下方）')
      onSynced()
    } catch (e) {
      setStatus(`同步失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleSync = () => {
    if (dirty) historyRef.current = [...historyRef.current, lastSaved]
    void sync(text)
  }

  const handleUndo = async () => {
    if (historyRef.current.length > 0) {
      const prev = historyRef.current.pop()!
      setText(prev)
      await sync(prev)
    } else if (dirty) {
      setText(lastSaved)
      setStatus('已撤销到上次同步')
    } else {
      setStatus('没有可撤销的修改')
    }
  }

  /* ---------- 工具栏：行内包裹 / 行前缀 ---------- */
  const wrap = (before: string, after = before, placeholder = '文本') => {
    const el = taRef.current
    if (!el) return
    const s = el.selectionStart ?? 0
    const e = el.selectionEnd ?? 0
    const sel = el.value.slice(s, e) || placeholder
    const next = el.value.slice(0, s) + before + sel + after + el.value.slice(e)
    setText(next)
    setTimeout(() => {
      el.focus()
      el.setSelectionRange(s + before.length, s + before.length + sel.length)
    })
  }

  const prefix = (p: string) => {
    const el = taRef.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e, value } = el
    const segStart = value.slice(0, s).lastIndexOf('\n') + 1
    const nl = value.indexOf('\n', e)
    const segEnd = nl === -1 ? value.length : nl + 1
    const block = value.slice(segStart, segEnd)
    const nextBlock = block
      .split('\n')
      .map((l) => (l.startsWith(p) ? l.slice(p.length) : p + l))
      .join('\n')
    const next = value.slice(0, segStart) + nextBlock + value.slice(segEnd)
    setText(next)
    setTimeout(() => el.focus())
  }

  /* ---------- 定位手机屏右键文字 ---------- */
  const nonce = jumpAnchor?.nonce ?? 0
  useEffect(() => {
    const anchor = jumpAnchor?.anchor
    if (!nonce || !anchor) return
    if (mode !== 'edit') setMode('edit')
    const t = setTimeout(() => {
      const el = taRef.current
      if (!el) return
      const idx = el.value.indexOf(anchor)
      if (idx < 0) {
        setStatus(`未定位到"${anchor}"`)
        return
      }
      el.focus()
      el.setSelectionRange(idx, idx + anchor.length)
      const before = el.value.slice(0, idx)
      const lineNo = (before.match(/\n/g) || []).length
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24
      el.scrollTop = Math.max(0, lineNo * lh - el.clientHeight / 3)
      setStatus('已定位到所选文字')
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  /** 按检测报告的行/列，精确选中包含问题的那个整句并进入编辑态 */
  const jumpTo = (line: number, column: number) => {
    const el = taRef.current
    if (!el) return
    if (mode !== 'edit') setMode('edit')
    const lines = el.value.split('\n')
    const lineIdx = Math.min(Math.max(line, 1), lines.length)
    let offset = 0
    for (let i = 0; i < lineIdx - 1; i += 1) offset += lines[i]!.length + 1
    offset += Math.max(0, column - 1)
    offset = Math.min(offset, el.value.length)
    // 以句末标点 + 引号 + 换行为界，圈出发现点所在的那一句/整段引语。
    // 发现点若是句号（如 mid-speech 命中在句中「。」），越过该句号继续向前，把整句引语都框进去；
    // 开引号「“/「」是起点边界，避免把引语前的大段旁白也选中。
    const boundary = (ch: string) =>
      ch === '\n' || '。！？!?…'.includes(ch) || ch === '“' || ch === '「' || ch === '”' || ch === '」'
    let sentStart = offset
    while (sentStart > 0 && !boundary(el.value[sentStart - 1]!)) sentStart -= 1
    let e = offset
    if ('。！？!?…'.includes(el.value[e] ?? '')) e += 1 // 发现点本身是句末标点时越过它
    while (e < el.value.length && !boundary(el.value[e]!)) e += 1
    if (e < el.value.length && el.value[e] !== '\n') e += 1 // 把结束标点/闭引号纳入
    const sentEnd = Math.max(sentStart, e)
    el.focus()
    el.setSelectionRange(sentStart, sentEnd)
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24
    el.scrollTop = Math.max(0, (lineIdx - 1) * lh - el.clientHeight / 3)
    setStatus(`已定位到第 ${line} 行`)
  }

  const editorStyle = { fontSize: `${editorFont}px` }

  return (
    <aside className="editor-pane">
      <div className="editor-head">
        <div className="editor-title">
          <span className="editor-badge"><Icon name="pencil" size={12} /> 编辑器</span>
          <span className="editor-ch">第 {chapterIdx} 章</span>
        </div>
        <div className="editor-actions">
          <div className="ed-font">
            <button
              className="fs-btn"
              disabled={editorFont <= 12}
              onClick={() => setEditorFont((f) => Math.max(12, f - 1))}
            >
              －
            </button>
            <input
              type="range"
              className="fs-range"
              min={12}
              max={30}
              step={1}
              value={editorFont}
              onChange={(e) => setEditorFont(Number(e.target.value))}
            />
            <button
              className="fs-btn"
              disabled={editorFont >= 30}
              onClick={() => setEditorFont((f) => Math.min(30, f + 1))}
            >
              ＋
            </button>
            <span className="ed-font-val">{editorFont}px</span>
          </div>
          <button className={`md-tab${mode === 'edit' ? ' active' : ''}`} onClick={() => setMode('edit')}>
            编辑
          </button>
          <button
            className={`md-tab${mode === 'preview' ? ' active' : ''}`}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button className="ed-btn" onClick={() => void handleUndo()} disabled={loading || syncing}>
            ↩ 撤销
          </button>
        </div>
      </div>
      {mode === 'edit' && (
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
        </div>
      )}
      {mode === 'edit' ? (
        <textarea
          ref={taRef}
          className="editor-textarea"
          style={editorStyle}
          value={text}
          disabled={loading || syncing}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder="在此编辑本章 markdown…"
        />
      ) : (
        <div
          className="editor-preview markdown-body"
          style={{ fontSize: `${editorFont}px` }}
          dangerouslySetInnerHTML={{ __html: md.render(text) }}
        />
      )}
      {gate && !gate.passed && (
        <div className="editor-gate warn">
          <div className="eg-title"><Icon name="warning" size={12} /> 质检提示（人工稿不强制拦截，仅告知）</div>
          {gate.report.scripts
            .filter((s) => s.exitCode !== 0)
            .map((s) => {
              const findings = parseFindings(s.output)
              return (
                <details key={s.name} className="eg-item">
                  <summary>
                    {s.name} · exit {s.exitCode}
                  </summary>
                  {findings.length > 0 ? (
                    <ul className="eg-list">
                      {findings.map((f, i) => (
                        <li key={i}>
                          <button
                            className="eg-find"
                            onClick={() => jumpTo(f.line, f.column)}
                            title={`第 ${f.line} 行 · ${f.severity} ${f.type}`}
                          >
                            <span className={`eg-sev ${f.severity}`}>{f.severity}</span>
                            <span className="eg-type">{f.type}</span>
                            <span className="eg-msg">{f.message}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <pre>{s.output}</pre>
                  )}
                </details>
              )
            })}
        </div>
      )}
      {gate && gate.passed && <div className="editor-gate ok"><Icon name="check-circle" size={12} /> 质检全绿</div>}
      <div className="editor-foot">
        <span className={`ed-status${dirty ? ' dirty' : ''}`}>
          {loading ? '加载中…' : dirty ? '● 有未同步修改' : status}
        </span>
        <button
          className="ed-sync"
          onClick={handleSync}
          disabled={loading || syncing || !dirty}
          title="把当前编辑内容写回磁盘并刷新阅读器"
        >
          {syncing ? '同步中…' : '⇪ 保存并刷新'}
        </button>
      </div>
    </aside>
  )
}
