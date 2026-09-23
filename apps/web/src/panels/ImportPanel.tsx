/**
 * M3 导入向导（重做版：方框+连线流程链视觉 + inbox 草稿队列）：
 * - 三步流程链（粘贴 → 元信息 → Agent 适配）与工作流图同语言；
 * - 草稿队列：inbox 历史草稿列表（文件名解析章号/标题 + 大小 + 时间），点击「载入」回填继续编辑；
 * - 移交 Agent 走 story-import 子流程（改写类操作停靠审批卡）。
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchInboxDrafts, fetchWorkspaceFile, saveInboxDraft, type InboxDraft } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

type Step = 1 | 2

/** 相对时间 */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

/** 字节 → 可读大小 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/** 文件名「第0011章_标题-时间戳.md」→ 章号 + 标题（解析失败回 null） */
function parseDraftName(name: string): { chapter: string; title: string } | null {
  const m = /^第(\d{1,4})章[_\- ]*(.*?)(?:-\d{4}-\d{2}-\d{2}T.*)?\.md$/.exec(name)
  if (!m) return null
  return { chapter: String(Number(m[1])), title: m[2] || '' }
}

export function ImportPanel({
  onSendToAgent,
}: {
  onSendToAgent: (text: string) => void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>(1)
  const [text, setText] = useState('')
  const [chapter, setChapter] = useState('')
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<'ai' | 'hand' | 'mixed'>('ai')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [drafts, setDrafts] = useState<InboxDraft[]>([])

  const refreshDrafts = useCallback(() => {
    void fetchInboxDrafts().then(setDrafts)
  }, [])
  useEffect(() => {
    refreshDrafts()
  }, [refreshDrafts])

  const SOURCE_LABEL = { ai: '其他 AI 生成', hand: '自己手写', mixed: '混合（AI 起稿 + 人工修改）' }

  const toStep2 = () => {
    if (text.trim().length < 50) {
      setError('正文太短（至少 50 字）。请粘贴完整章节内容。')
      return
    }
    setError('')
    setStep(2)
  }

  const submit = async () => {
    const ch = Number(chapter)
    if (!Number.isInteger(ch) || ch < 1 || ch > 99999) {
      setError('章号需为正整数（如 11）')
      return
    }
    if (!title.trim()) {
      setError('请填写章节标题')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await saveInboxDraft(text, `第${String(ch).padStart(4, '0')}章_${title.trim()}`)
      onSendToAgent(
        `请导入第 ${ch} 章《${title.trim()}》。草稿已保存在 ${r.path}，来源：${SOURCE_LABEL[source]}。` +
          '请按 story-import 的外部章节适配子流程处理：读草稿 → 格式规范 → 质检（check-degeneration / check-ai-patterns）→' +
          '如有 blocking 先告诉我处理建议（只标记不改 or 去AI味改写），改写必须先给 diff 确认 → 落盘 正文/ → tracking commit 补录。原始草稿保留在 inbox，不要删除。',
      )
      // 重置向导，供下一章导入
      setStep(1)
      setText('')
      setChapter('')
      setTitle('')
      refreshDrafts()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 载入历史草稿回填（步骤1 + 元信息预填） */
  const loadDraft = async (d: InboxDraft) => {
    setBusy(true)
    setError('')
    try {
      const content = await fetchWorkspaceFile(d.path)
      if (!content) {
        setError('草稿读取失败')
        return
      }
      const parsed = parseDraftName(d.name)
      setText(content)
      if (parsed) {
        setChapter(parsed.chapter)
        setTitle(parsed.title)
      }
      setStep(1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="import-panel">
      <div className="imp-head">
        <span className="imp-badge"><Icon name="inbox" size={13} /> 导入向导</span>
        <span className="imp-step">
          第 {step}/2 步 · {step === 1 ? '粘贴正文' : '元信息与移交'}
        </span>
      </div>

      {/* 三步流程链（与工作流图同语言：方框 + 连线） */}
      <div className="imp-flow">
        <span className={`imp-node${step >= 1 ? ' on' : ''}`}>
          <i>1</i> 粘贴正文
        </span>
        <span className="imp-link" aria-hidden />
        <span className={`imp-node${step >= 2 ? ' on' : ''}`}>
          <i>2</i> 元信息
        </span>
        <span className="imp-link" aria-hidden />
        <span className="imp-node">
          <i>3</i> Agent 适配
        </span>
      </div>

      {step === 1 ? (
        <>
          <div className="imp-tip">
            把别处写好的章节正文粘贴到下面（支持 Markdown / 纯文本）。Agent 会做格式规范、质检、去AI味（可选）与追踪补录。
          </div>
          <textarea
            className="imp-textarea"
            value={text}
            rows={12}
            placeholder={'在此粘贴外部章节正文…\n\n（无需手动整理章节头，Agent 会按「# 第NNN章 标题」规范）'}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <div className="imp-meta-info">
            当前 {text.length} 字{text.length > 0 ? `（约 ${Math.round(text.replace(/\s/g, '').length)} 有效字符）` : ''}
          </div>
          <div className="imp-actions">
            <button type="button" className="btn-primary" onClick={toStep2} disabled={!text.trim()}>
              下一步：填写元信息 →
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="imp-form">
            <label className="imp-field">
              <span>目标章号 *</span>
              <input
                type="number"
                min={1}
                value={chapter}
                placeholder="如 11"
                onChange={(e) => setChapter(e.target.value)}
              />
            </label>
            <label className="imp-field">
              <span>章节标题 *</span>
              <input
                type="text"
                value={title}
                placeholder="如 首次出城"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="imp-field">
              <span>来源</span>
              <select value={source} onChange={(e) => setSource(e.target.value as 'ai' | 'hand' | 'mixed')}>
                <option value="ai">其他 AI 生成</option>
                <option value="hand">自己手写</option>
                <option value="mixed">混合（AI 起稿 + 人工修改）</option>
              </select>
            </label>
          </div>
          <div className="imp-tip">
            草稿将保存到 <code>.story-studio/inbox/</code>，随后 Agent 接管处理。改写类操作会弹出审批卡片（带 diff 预览），不会静默覆盖。
          </div>
          <div className="imp-actions">
            <button type="button" className="btn-ghost" onClick={() => setStep(1)} disabled={busy}>
              ← 上一步
            </button>
            <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy}>
              {busy ? '保存草稿中…' : '保存并交给 Agent 处理'}
            </button>
          </div>
        </>
      )}
      {error && <div className="imp-error">{error}</div>}

      {/* 草稿队列：inbox 历史草稿 */}
      {drafts.length > 0 && (
        <div className="imp-queue">
          <div className="imp-queue-head">
            <span className="imp-queue-title">
              <Icon name="folder" size={12} /> 历史草稿（{drafts.length}）
            </span>
            <span className="imp-queue-sub">点击载入继续编辑，再走一遍元信息/移交</span>
          </div>
          <div className="imp-queue-list">
            {drafts.slice(0, 8).map((d) => {
              const parsed = parseDraftName(d.name)
              return (
                <button key={d.path} type="button" className="imp-queue-item" onClick={() => void loadDraft(d)} disabled={busy} title={d.path}>
                  <span className="imp-queue-ch">
                    {parsed ? `第 ${parsed.chapter} 章` : '草稿'}
                  </span>
                  <span className="imp-queue-title-text">{parsed?.title || d.name}</span>
                  <span className="imp-queue-meta">
                    {fmtSize(d.bytes)} · {ago(d.mtime)}
                  </span>
                  <span className="imp-queue-load">载入</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
