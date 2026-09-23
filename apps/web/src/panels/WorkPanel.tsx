/**
 * 工作区面板容器：视图切换（手机阅读器 / 资料卡墙 / 追踪面板 / 导入向导 / 报告）+ 编辑器联动。
 * - 模式驱动默认视图（write→reader、discuss→cards、import→import、review/market→report…）
 * - 「跟随 Agent」：Agent 写完新章（WS 门禁通过/新章节落盘）自动跳转阅读器
 * - 手机屏右键正文 → 锚点定位编辑器；编辑器保存 → reloadSignal 刷新阅读器
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookInfo, DocCard, DocSection, WsEvent } from '@story-studio/shared'
import { fetchBook, fetchDocs } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { PhoneFrame } from '../reader/PhoneFrame.tsx'
import { Reader } from '../reader/Reader.tsx'
import { CardsView } from './CardsView.tsx'
import { DocWorkbench } from './DocWorkbench.tsx'
import { EmbeddedPane } from './EmbeddedPane.tsx'
import { EditorPanel } from './EditorPanel.tsx'
import { ImportPanel } from './ImportPanel.tsx'
import { FanficPanel } from './FanficPanel.tsx'
import { PolishPanel } from './PolishPanel.tsx'
import { ReportPanel } from './ReportPanel.tsx'
import { TrackingPanel } from './TrackingPanel.tsx'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import type { RunLive } from '../chat/RunLive.ts'

type View = 'workflow' | 'reader' | 'cards' | 'tracking' | 'import' | 'polish' | 'report' | 'fanfic'
type DocKey = '大纲' | '设定' | '追踪'

const DOC_KEYS: DocKey[] = ['大纲', '设定', '追踪']

const DOC_LABEL: Record<DocKey, string> = {
  大纲: '大纲',
  设定: '设定',
  追踪: '追踪',
}

interface Props {
  wsEvent: WsEvent | null
  /** 书切换信号（nonce 变化 → 全量刷新章节/资料） */
  bookSwitched?: number
  /** 模式驱动的默认视图（外部模式切换时跳转） */
  defaultView: View
  /** 卡墙默认聚焦的库 */
  defaultDocKey?: DocKey
  /** 导入向导移交给 Agent（经 App 转发到 ChatPanel 发送） */
  onSendToAgent?: (text: string) => void
  /** 资源管理器点开的文件（只读）→ 自动切到文档编辑页展示 */
  openFile?: { path: string; content: string } | null
  onConsumeFile?: () => void
  /** 是否有全屏覆盖模态打开（书架/日志/设置）——嵌入式浏览器原生视图在 DOM 上，需隐藏让位 */
  covered?: boolean
  /** 交付卡「去阅读本章」跳章信号（nonce 变化触发）：切回可视化阅读视图并定位章节 */
  jumpSignal?: { chapter: number; nonce: number } | null
  /** Agent 运行实时快照（ChatPanel 上浮）：工作流画布点亮 */
  runLive?: RunLive | null
  /** 当前模型 id（执行画布 Start 节点徽章展示） */
  modelLabel?: string | null
}

export function WorkPanel({
  wsEvent,
  bookSwitched = 0,
  defaultView,
  defaultDocKey = '大纲',
  onSendToAgent,
  openFile,
  onConsumeFile,
  covered = false,
  jumpSignal = null,
  runLive = null,
  modelLabel = null,
}: Props) {
  const [view, setView] = useState<View>(defaultView)
  /** 一级功能：可视化（五视图）/ 文档编辑（栏内）/ Agent浏览器（桌面嵌入） */
  const [fn, setFn] = useState<'visual' | 'docedit' | 'embedded'>('visual')
  const [docCard, setDocCard] = useState<DocCard | null>(null)
  /** 资源管理器文件的内容（有值 = 只读直显，不走 fetchDoc） */
  const [extPreload, setExtPreload] = useState<string | null>(null)
  const [book, setBook] = useState<BookInfo | null>(null)
  const [docs, setDocs] = useState<DocSection[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [docKey, setDocKey] = useState<DocKey>(defaultDocKey)

  const [chapterIdx, setChapterIdx] = useState(1)
  const [reloadSignal, setReloadSignal] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [jumpAnchor, setJumpAnchor] = useState<{ anchor?: string; nonce: number } | null>(null)
  const [follow, setFollow] = useState(true)

  const latestChapterRef = useRef(0)
  const followRef = useRef(follow)
  followRef.current = follow

  /** 是否为桌面应用（embedded 原生视图仅桌面有）——agent 操控光圈的自动切面只在此生效 */
  const isDesktop = typeof window !== 'undefined' && !!window.storyDesktop
  /**
   * 浏览器操控状态：'agent' = agent/脚本操控中（绿光圈）；'human' = 需要人工操作（红光圈爆闪直至 login-resolved）。
   * 人工状态优先：agent 的活跃脉冲不覆盖红色。
   * 持续时间模型：true 点亮 → false 后 6s 宽限熄灭（防止长脚本/操作衔接闪烁）→ 5 分钟绝对安全上限
   * （防某工具发 true 后异常退出没发 false 导致光圈永久常亮）。长脚本（分钟级）不再中途淡出。
   */
  const [browserControl, setBrowserControl] = useState<'agent' | 'human' | null>(null)
  const controlRef = useRef<'agent' | 'human' | null>(null)
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setControlOff = useCallback(() => {
    controlRef.current = null
    setBrowserControl(null)
  }, [])
  useEffect(() => {
    return () => {
      if (graceTimer.current) clearTimeout(graceTimer.current)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
    }
  }, [])

  const refreshBook = useCallback(async () => {
    try {
      const b = await fetchBook()
      setBook(b)
      latestChapterRef.current = b.latestChapter
    } catch {
      // 服务未就绪
    }
  }, [])

  const refreshDocs = useCallback(async () => {
    setDocsLoading(true)
    try {
      setDocs(await fetchDocs())
    } catch {
      // ignore
    } finally {
      setDocsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshBook()
    void refreshDocs()
  }, [refreshBook, refreshDocs])

  // 切书信号：章节/资料全量刷新 + 阅读器回到第 1 章
  useEffect(() => {
    if (bookSwitched === 0) return
    setChapterIdx(1)
    void refreshBook()
    void refreshDocs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookSwitched])

  // 模式切换 → 默认视图（并从 文档编辑/浏览器 回到可视化，保证视图跳转可见）
  const lastDefaultRef = useRef(defaultView)
  useEffect(() => {
    if (defaultView !== lastDefaultRef.current) {
      lastDefaultRef.current = defaultView
      setView(defaultView)
      setFn('visual')
      setDocCard(null)
      setExtPreload(null)
      if (defaultView === 'cards') setDocKey(defaultDocKey)
    }
  }, [defaultView, defaultDocKey])

  // 资源管理器文件到达 → 文档编辑页展示（可编辑；追踪/ 派生视图由 DocWorkbench 按路径判定只读）
  useEffect(() => {
    if (!openFile) return
    const name = openFile.path.split(/[\\/]/).pop() ?? openFile.path
    setDocCard({ path: openFile.path, title: name, name, kind: 'md' })
    setExtPreload(openFile.content)
    setFn('docedit')
  }, [openFile])

  // 交付卡「去阅读本章」：切回可视化阅读视图，刷新章节列表后定位（新章可能尚未入列）
  useEffect(() => {
    if (!jumpSignal) return
    setFn('visual')
    setView('reader')
    void refreshBook().then(() => setChapterIdx(jumpSignal.chapter))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal])

  // Agent 开始新一轮执行 → 自动切到工作流画布（用户看得到节点实时生长；切走后下一轮开始再切）
  const prevWorkingRef = useRef(false)
  useEffect(() => {
    const w = runLive?.working ?? false
    if (w && !prevWorkingRef.current) {
      setFn('visual')
      setView('workflow')
    }
    prevWorkingRef.current = w
  }, [runLive?.working])

  // WS 事件：新章节落盘/门禁通过 → 跟随跳转；资料变更 → 刷新卡墙
  useEffect(() => {
    if (!wsEvent) return
    if (wsEvent.type === 'gate:result' && wsEvent.report.passed) {
      const ch = wsEvent.report.chapter
      if (ch && ch > latestChapterRef.current) {
        latestChapterRef.current = ch
        void refreshBook().then(() => {
          if (followRef.current) {
            setChapterIdx(ch)
            setView('reader')
          }
        })
      }
    } else if (wsEvent.type === 'file:changed') {
      if (wsEvent.kind === 'chapter') {
        void refreshBook()
      } else if (wsEvent.kind === 'source') {
        // 同人：进度文件被 agent 回写（步骤状态迁移/卷登记）→ 自动切同人面板看下一步操作
        if (wsEvent.path === '原著/_progress.json') {
          setFn('visual')
          setView('fanfic')
        }
      } else if (view === 'cards' || wsEvent.kind === 'tracking') {
        if (view === 'cards') void refreshDocs()
      }
    } else if (wsEvent.type === 'browser:login-required') {
      // 人工接管：红光圈爆闪（需要人工操作——登录/滑块等），Agent 暂停等待中；切到浏览器面板呈现画面
      setFn('embedded')
      controlRef.current = 'human'
      setBrowserControl('human')
      if (graceTimer.current) clearTimeout(graceTimer.current)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
      graceTimer.current = null
      safetyTimer.current = null
    } else if (wsEvent.type === 'browser:login-resolved') {
      // 接管完成：红光圈解除（agent 后续操作由绿光圈接管）
      if (controlRef.current === 'human') {
        controlRef.current = null
        setBrowserControl(null)
      }
    } else if (wsEvent.type === 'browser:agent-control') {
      // agent/脚本操控绿光圈：人工接管状态优先（不覆盖红）；true 点亮，false 后 6s 宽限熄灭，5 分钟安全上限
      if (controlRef.current === 'human') return
      if (wsEvent.active) {
        const firstPulse = !controlRef.current
        controlRef.current = 'agent'
        setBrowserControl('agent')
        if (firstPulse && isDesktop) setFn('embedded')
        if (graceTimer.current) clearTimeout(graceTimer.current)
        graceTimer.current = null
        if (safetyTimer.current) clearTimeout(safetyTimer.current)
        safetyTimer.current = setTimeout(() => {
          if (controlRef.current === 'agent') setControlOff()
        }, 5 * 60_000)
      } else {
        // 结束脉冲 → 宽限期后熄灭（期间若有新 true 立即重亮，避免衔接闪烁）
        if (controlRef.current !== 'agent') return
        if (safetyTimer.current) clearTimeout(safetyTimer.current)
        safetyTimer.current = null
        if (graceTimer.current) clearTimeout(graceTimer.current)
        graceTimer.current = setTimeout(() => {
          if (controlRef.current === 'agent') setControlOff()
        }, 6_000)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsEvent])

  const chapters = book?.chapters ?? []
  const section = docs.find((s) => s.key === docKey)

  const handleEditorJump = (anchor: string) => {
    setEditorOpen(true)
    setJumpAnchor({ anchor, nonce: Date.now() })
  }

  return (
    <div className="work-panel">
      <div className="wp-fn-tabs">
        <button
          type="button"
          data-label="可视化"
          className={`wp-fn-tab${fn === 'visual' ? ' active' : ''}`}
          onClick={() => setFn('visual')}
        >
          <Icon name="collection" size={13} /> 可视化
        </button>
        <button
          type="button"
          data-label="文档编辑"
          className={`wp-fn-tab${fn === 'docedit' ? ' active' : ''}`}
          onClick={() => setFn('docedit')}
        >
          <Icon name="pencil" size={13} /> 文档编辑
        </button>
        <button
          type="button"
          data-label="Agent浏览器"
          className={`wp-fn-tab${fn === 'embedded' ? ' active' : ''}`}
          title="Agent 专属浏览器：扫榜/网页 AI 在这里真实打开并可视化，可人工接管登录，绝不动系统浏览器"
          onClick={() => setFn('embedded')}
        >
          <Icon name="monitor" size={13} /> Agent浏览器
        </button>
      </div>

      {fn === 'docedit' && (
        <div className="wp-body view-docedit">
          <DocWorkbench
            card={docCard}
            preload={extPreload ?? undefined}
            onClose={() => {
              setFn('visual')
              setDocCard(null)
              setExtPreload(null)
              onConsumeFile?.()
            }}
          />
        </div>
      )}
      {fn === 'embedded' && (
        <div className="wp-body view-embedded">
          <EmbeddedPane covered={covered} control={browserControl} />
        </div>
      )}
      {fn === 'visual' && (
      <>
      <div className="wp-tabs">
        <div className="wp-view-tabs">
          <button
            type="button"
            className={`wp-tab${view === 'workflow' ? ' active' : ''}`}
            onClick={() => setView('workflow')}
            title="创作工作流：Agent 执行到哪一步、下一步是什么"
          >
            <Icon name="clipboard-list" size={13} /> 工作流
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'reader' ? ' active' : ''}`}
            onClick={() => setView('reader')}
          >
            <Icon name="book-open" size={13} /> 阅读
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'cards' ? ' active' : ''}`}
            onClick={() => {
              setView('cards')
              void refreshDocs()
            }}
          >
            <Icon name="collection" size={13} /> 资料
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'tracking' ? ' active' : ''}`}
            onClick={() => setView('tracking')}
          >
            <Icon name="dna" size={13} /> 追踪
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'import' ? ' active' : ''}`}
            onClick={() => setView('import')}
          >
            <Icon name="inbox" size={13} /> 导入
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'polish' ? ' active' : ''}`}
            onClick={() => setView('polish')}
            title="选章优化：勾选章节交给 Agent 去AI味/文笔优化"
          >
            <Icon name="spark" size={13} /> 优化
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'report' ? ' active' : ''}`}
            onClick={() => setView('report')}
          >
            <Icon name="chart-bar" size={13} /> 报告
          </button>
          <button
            type="button"
            className={`wp-tab${view === 'fanfic' ? ' active' : ''}`}
            onClick={() => setView('fanfic')}
            title="同人衍生：四步创作指南 / 原著上传 / 拆书进度 / 卷纲细纲"
          >
            <Icon name="dna" size={13} /> 同人
          </button>
        </div>
        {view === 'cards' && (
          <div className="wp-doc-tabs">
            {DOC_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={`wp-doc-tab${docKey === k ? ' active' : ''}`}
                onClick={() => setDocKey(k)}
              >
                {DOC_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        {view === 'reader' && (
          <div className="wp-reader-opts">
            <label className="follow-toggle" title="Agent 写完新章后自动跳转到该章">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              跟随 Agent
            </label>
            <button
              type="button"
              className={`wp-tab small${editorOpen ? ' active' : ''}`}
              onClick={() => setEditorOpen((v) => !v)}
            >
            <Icon name="pencil" size={12} /> 编辑器
            </button>
          </div>
        )}
        {book && book.trackingRevision !== null && view !== 'tracking' && (
          <span className="wp-chip" title="追踪状态修订号 / 已提交章节数">
            <Icon name="dna" size={12} /> rev {book.trackingRevision} · 第 {book.lastCommittedChapter ?? '?'} 章
          </span>
        )}
      </div>

      <div className={`wp-body view-${view}${editorOpen ? ' with-editor' : ''}`}>
        {view === 'workflow' && (
          <div className="wp-wf-wrap">
            <WorkflowPanel
              latestChapter={book?.latestChapter ?? 0}
              runLive={runLive}
              modelLabel={modelLabel}
            />
          </div>
        )}
        {view === 'reader' && (
          <>
            <div className="wp-phone-wrap">
              <PhoneFrame title={book?.title ?? '…'}>
                <Reader
                  bookTitle={book?.title ?? '…'}
                  chapters={chapters}
                  chapterIdx={chapterIdx}
                  onChapterChange={setChapterIdx}
                  reloadSignal={reloadSignal}
                  onEditorJump={handleEditorJump}
                  editorOpen={editorOpen}
                  onToggleEditor={() => setEditorOpen((v) => !v)}
                />
              </PhoneFrame>
            </div>
            {editorOpen && (
              <EditorPanel
                chapterIdx={chapterIdx}
                onSynced={() => setReloadSignal((n) => n + 1)}
                jumpAnchor={jumpAnchor}
              />
            )}
          </>
        )}
        {view === 'cards' && (
          <div className="wp-cards-wrap">
            <CardsView
              section={section}
              loading={docsLoading}
              kindLabel={DOC_LABEL[docKey]}
              onSendToAgent={(t) => onSendToAgent?.(t)}
              onOpenDoc={(c) => {
                setDocCard(c)
                setFn('docedit')
              }}
            />
          </div>
        )}
        {view === 'tracking' && <TrackingPanel wsEvent={wsEvent} />}
        {view === 'import' && (
          <div className="wp-import-wrap">
            <ImportPanel onSendToAgent={(t) => onSendToAgent?.(t)} />
          </div>
        )}
        {view === 'polish' && (
          <div className="wp-import-wrap">
            <PolishPanel chapters={chapters} onSendToAgent={(t) => onSendToAgent?.(t)} />
          </div>
        )}
        {view === 'report' && <ReportPanel wsEvent={wsEvent} />}
        {view === 'fanfic' && (
          <div className="wp-import-wrap">
            <FanficPanel wsEvent={wsEvent} onSendToAgent={(t) => onSendToAgent?.(t)} />
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}
