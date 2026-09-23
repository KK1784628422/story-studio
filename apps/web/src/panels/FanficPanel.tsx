/**
 * 同人衍生模式面板（四步制创作指南）：① 详细设定（原著+专属，「资料」同款卡墙 → DocWorkbench 查看/编辑 + AI 完善）
 * → ② 拆书（上传原文 + 卷进度列表，点卷查看 摘要/原著时间线（点行选同人分岔点）/角色发展/总结；此处只有原著时间线）
 * → ③ 完善卷纲与细纲（核心：本书卷列表 → 卷详情（时间线对照点击点亮 + 细纲逐章勾选确认变绿））→ ④ 创作（勾选已确认细纲开始写作，循环拆书回②）。
 * - 四步卡仅作页面导航（默认落「设定」页），不显示/不跟随当前流程步骤；流程真实位置仍由 _progress.json 记录（Agent 断点续传用）；
 * - 确认/推进走结构化接口（/api/fanfic/confirm|advance|volume-create|chapters-confirm|fork），不再依赖聊天话术；
 *   Agent 侧干活（检索/拆书/写大纲）仍经聊天话术触发；
 * - 进度数据 GET /api/fanfic/progress（_progress.json v2 + 磁盘派生真值），原著/ 文件变更经 WS 自动刷新。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocCard, FanficFileGroup, FanficFicVolume, FanficProgress, FanficVolumeDetail, WsEvent } from '@story-studio/shared'
import { FANFIC_STEPS } from '@story-studio/shared'
import {
  fanficAdvance,
  fanficChaptersConfirm,
  fanficConfirmVolumes,
  fanficSetFork,
  fanficVolumeCreate,
  fetchFanficFiles,
  fetchFanficProgress,
  fetchFanficVolume,
  fetchWorkspaceFile,
  uploadFanficSource,
} from '../api.ts'
import { DocWorkbench } from './DocWorkbench.tsx'
import { docAgo } from './RelNet.tsx'
import { Icon } from '../components/Icon.tsx'

/** 四步指南（欢迎形态展示；第 3 步核心、第 4 步产出；标签用 shared FANFIC_STEPS 单一来源） */
const FANFIC_GUIDE: Array<{ label: string; desc: string; mark?: string }> = [
  { label: '① 详细设定', desc: 'Agent 联网检索原著世界观 / 角色 / 势力，再 15 问问清你的专属设定。全部设定文件在本面板展示（「资料」同款卡墙），随时查看、直接编辑或一键让 AI 完善，也可用「新建设定」补充。' },
  { label: '② 拆书', desc: '上传原著原文（单卷 ≤2MB），按事件桥段拆解摘要，记录原著时间线并在卷详情里点选同人分岔点。点开任意卷即可查看 摘要 / 角色发展 / 时间线 / 总结。' },
  { label: '③ 完善卷纲与细纲', desc: '拆书页「＋ 新建卷纲」登记本书卷（勾选对应原著卷 + 卷名 + 预计章节数）；卷详情里对照时间线、编辑卷纲与细纲，勾选已完善的细纲章确认（变绿）。', mark: '核心' },
  { label: '④ 创作', desc: '勾选已确认（绿色）的细纲章开始创作，AI 从所选章号起走单章 13 步流程（质检 + 追踪全复用）；下一卷原著上传后回第 2 步循环拆书。', mark: '产出' },
]

/** 卷状态 → 中文 + 样式类（done 为服务端磁盘真值派生：摘要覆盖全卷） */
const VOL_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待拆解', cls: 'pending' },
  in_progress: { label: '拆解中', cls: 'progress' },
  done: { label: '拆解完成', cls: 'done' },
  confirmed: { label: '已确认', cls: 'confirmed' },
}

/** 字节 → 可读大小 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/** 时间线对比表行 */
interface TimelineRow {
  seq: string
  track: '原著' | '本书'
  time: string
  event: string
  source: string
  fork: boolean
}

/** 解析时间线对比 md（<!--fanfic-timeline v1--> 标记后的表格行）；失败返回 null 走降级 */
function parseTimeline(md: string): TimelineRow[] | null {
  const marker = md.indexOf('<!--fanfic-timeline v1-->')
  if (marker < 0) return null
  const rows: TimelineRow[] = []
  for (const line of md.slice(marker).split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    // 跳过表头/分隔行（首个单元格为「序」或空/连字符）
    if (cells[1] === '序' || /^[-: ]+$/.test(cells[2] ?? '')) continue
    // 轨道词：新规范「本书」，旧文件「同人」均归本书侧
    const track = cells[2] === '原著' ? '原著' : cells[2] === '同人' || cells[2] === '本书' ? '本书' : null
    if (!track) continue
    rows.push({
      seq: cells[1] ?? '',
      track,
      time: cells[3] ?? '',
      event: cells[4] ?? '',
      source: cells[5] ?? '',
      fork: (cells[4] ?? '').includes('分岔点'),
    })
  }
  return rows.length > 0 ? rows : null
}

/** 对照行：同一故事时间的原著/本书事件并排（对比表规范要求同时间两轨相邻排，按时间串联合并即可） */
interface TimelinePair {
  time: string
  orig: string[]
  fic: string[]
  /** 本行含分岔点（同人偏离原著的起点） */
  fork: boolean
}

function pairTimelineRows(rows: TimelineRow[]): TimelinePair[] {
  const out: TimelinePair[] = []
  let cur: TimelinePair | null = null
  for (const r of rows) {
    if (!cur || cur.time !== r.time) {
      cur = { time: r.time, orig: [], fic: [], fork: false }
      out.push(cur)
    }
    if (r.track === '原著') cur.orig.push(r.event)
    else {
      cur.fic.push(r.event)
      if (r.fork) cur.fork = true
    }
  }
  return out
}

/** 本书卷章号区间（按登记顺序累加预计章节数：卷1 = 1..N，卷2 = N+1..M，细纲_第NNN章.md 按此归属卷） */
function ficVolRange(vols: FanficFicVolume[], id: number): [number, number] {
  const idx = vols.findIndex((v) => v.id === id)
  const start = vols.slice(0, Math.max(0, idx)).reduce((n, v) => n + v.chapters, 0) + 1
  const count = vols[idx]?.chapters ?? 0
  return [start, start + Math.max(0, count - 1)]
}

/** 拆书时间线行（原著/拆书/第V卷/时间线.md 的 4 列表格：| 故事时间 | 事件 | 出场 | 章节 |） */
interface SourceTimelineRow {
  time: string
  event: string
  cast: string
  chapter: string
}

/** 解析拆书时间线 md 表格；失败返回 null 走降级 */
function parseSourceTimeline(md: string): SourceTimelineRow[] | null {
  const rows: SourceTimelineRow[] = []
  for (const line of md.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    // 跳过表头/分隔行（首个单元格为「故事时间」或空/连字符）
    if (cells[1] === '故事时间' || /^[-: ]+$/.test(cells[2] ?? '')) continue
    if (!cells[2]) continue
    rows.push({ time: cells[1] ?? '', event: cells[2], cast: cells[3] ?? '', chapter: cells[4] ?? '' })
  }
  return rows.length > 0 ? rows : null
}

/** 文件路径 → 展示名（去目录与扩展名） */
const baseName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '')

/** 面板文件清单条目 → 资料卡（复用「资料」视图的 DocCard/卡墙样式与 DocWorkbench 编辑器） */
function toDocCard(f: { name: string; path: string; bytes: number; mtime: number }): DocCard {
  return { path: f.path, name: f.name, kind: 'md', title: baseName(f.path), bytes: f.bytes, mtime: f.mtime }
}

/** 设定/大纲文件卡墙（视觉与可视化栏「资料」CardsView 一致：card-group/card-grid/doc-card 同一套类名；点击 → DocWorkbench） */
function FanficFileWall({
  groups,
  emptyHint,
  onOpen,
}: {
  groups: Array<{ label: string; desc: string; cards: DocCard[] }>
  emptyHint: string
  onOpen: (card: DocCard) => void
}): React.JSX.Element {
  const total = groups.reduce((n, g) => n + g.cards.length, 0)
  return (
    <div className="cards-view fanfic-cards-view">
      <header className="cards-head">
        <span className="cards-count">{total} 份文档</span>
      </header>
      {total === 0 && <div className="fanfic-fgroup-empty">{emptyHint}</div>}
      {groups.map((g) => (
        <section key={g.label} className="card-group">
          <h3 className="card-group-title">{g.label}</h3>
          {g.desc && <div className="fanfic-fgroup-desc">{g.desc}</div>}
          {g.cards.length === 0 ? (
            <div className="fanfic-fgroup-empty">暂无文件</div>
          ) : (
            <div className="card-grid">
              {g.cards.map((c) => (
                <button key={c.path} type="button" className="doc-card" onClick={() => onOpen(c)} title={`打开：${c.path}`}>
                  <span className="doc-card-kind md">MD</span>
                  <span className="doc-card-title">{c.title}</span>
                  <span className="doc-card-file">{c.name}</span>
                  <span className="doc-card-meta">
                    {c.bytes != null ? fmtSize(c.bytes) : ''}
                    {c.mtime != null ? ` · ${docAgo(c.mtime)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
      <div className="cards-hint">
        <Icon name="pencil" size={12} /> 点击卡片用「资料」同款编辑器查看 / 编辑（富文本，保存即时落盘）
      </div>
    </div>
  )
}

/** 拆书卷详情卡：摘要（逐文件折叠）+ 时间线（点行选同人分岔点）/角色发展/总结 + 确认本卷 + 继续拆书 */
function VolumeDetail({
  id,
  onSendToAgent,
  onConfirm,
  onRefresh,
  onClose,
}: {
  id: number
  onSendToAgent: (text: string) => void
  onConfirm: (ids: number[]) => Promise<Record<string, string[]>>
  onRefresh: () => void
  onClose: () => void
}): React.JSX.Element {
  const [data, setData] = useState<FanficVolumeDetail | null>(null)
  const [tab, setTab] = useState<'summaries' | 'timeline' | 'characters' | 'summary'>('summaries')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    void fetchFanficVolume(id).then(setData)
  }, [id])
  useEffect(() => {
    load()
  }, [load])

  const confirm = async () => {
    setBusy(true)
    setMsg('')
    try {
      const miss = await onConfirm([id])
      const missList = Object.entries(miss).flatMap(([, files]) => files)
      setMsg(missList.length > 0 ? `已确认（缺 ${missList.join('、')}，已通知 AI 补齐）` : '已确认本卷拆书')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 分岔点选择：点原著时间线行 → 写 _progress.json volumes[].forkEvent（第 3 步卷纲据此展开同人轨） */
  const setFork = async (event: string) => {
    setBusy(true)
    setMsg('')
    try {
      await fanficSetFork(id, event)
      setMsg(event ? `已标记分岔点：${event}（可在第 3 步卷纲前随时更换）` : '已清除分岔点标记')
      load()
      onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const vol = data?.volume
  const forkEvent = vol?.forkEvent ?? ''
  const timelineRows = data?.artifacts.timeline ? parseSourceTimeline(data.artifacts.timeline) : null
  const tabs = [
    { key: 'summaries', label: `摘要${data ? `（${data.summaries.length}）` : ''}` },
    { key: 'timeline', label: '时间线' },
    { key: 'characters', label: '角色发展' },
    { key: 'summary', label: '总结' },
  ] as const

  return (
    <div className="fanfic-vol-detail">
      <div className="fanfic-vol-detail-head">
        <b>
          第 {id} 卷{vol?.label && vol.label !== `第${id}卷` ? `「${vol.label}」` : ''} 拆书详情
        </b>
        {vol && (
          <span className={`fanfic-vol-status ${VOL_STATUS[vol.status]?.cls ?? 'pending'}`}>
            {VOL_STATUS[vol.status]?.label ?? vol.status}
          </span>
        )}
        <button type="button" className="fanfic-vol-close" title="收起" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="fanfic-tabs">
        {tabs.map((t) => (
          <button key={t.key} type="button" className={`fanfic-tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="fanfic-tip">加载中…</div>
      ) : tab === 'summaries' ? (
        <div className="fanfic-vol-summaries">
          {data.summaries.length === 0 && <div className="fanfic-tip">本卷还没有桥段摘要——先上传原文并开始拆书</div>}
          {data.summaries.map((s) => (
            <details key={s.path} className="fanfic-summary-item">
              <summary>{s.name.replace(/\.md$/, '')}</summary>
              <pre>{s.content}</pre>
            </details>
          ))}
        </div>
      ) : tab === 'timeline' ? (
        <div className="fanfic-vol-timeline">
          <div className="fanfic-tip">
            点击事件行，把它标记为<b>同人分岔点</b>——同人剧情从该事件后偏离原著；第 3 步卷纲会据此生成双轨时间线。带 ⚑ 的是当前分岔点。
          </div>
          {forkEvent && (
            <button type="button" className="fanfic-fork-clear" disabled={busy} onClick={() => void setFork('')}>
              ✕ 清除分岔点
            </button>
          )}
          {timelineRows ? (
            <div className="fanfic-src-timeline">
              {timelineRows.map((r, i) => (
                <button
                  key={`t${i}`}
                  type="button"
                  disabled={busy}
                  className={`fanfic-src-row${forkEvent && r.event === forkEvent ? ' fork' : ''}`}
                  title={`出场：${r.cast || '—'} · 章节：${r.chapter || '—'}${forkEvent && r.event === forkEvent ? '（当前分岔点）' : '（点击标记为同人分岔点）'}`}
                  onClick={() => void setFork(r.event)}
                >
                  <span className="fanfic-src-time">{r.time}</span>
                  <span className="fanfic-src-event">
                    {forkEvent && r.event === forkEvent ? '⚑ ' : ''}
                    {r.event}
                  </span>
                  <span className="fanfic-src-ch">{r.chapter}</span>
                </button>
              ))}
            </div>
          ) : (
            <pre className="fanfic-vol-artifact">
              {data.artifacts.timeline ?? '本卷 时间线.md 尚未生成——拆书完成聚合后自动出现'}
            </pre>
          )}
        </div>
      ) : (
        <pre className="fanfic-vol-artifact">
          {tab === 'characters'
            ? (data.artifacts.characters ?? '本卷 角色发展.md 尚未生成')
            : (data.artifacts.summary ?? '本卷 总结.md 尚未生成')}
        </pre>
      )}
      <div className="fanfic-vol-detail-actions">
        {vol && vol.status !== 'confirmed' && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void confirm()}>
            ✓ 确认本卷拆书
          </button>
        )}
        <button
          type="button"
          className="btn-ghost"
          onClick={() =>
            onSendToAgent(
              `请继续拆解 原著/拆书/第${id}卷：按事件桥段推进摘要（禁止逐章写摘要；有旧单章摘要先归并），完成后聚合 时间线/角色发展/总结 让我在面板确认。`,
            )
          }
        >
          继续拆书本卷
        </button>
      </div>
      {msg && <div className="fanfic-filepane-msg">{msg}</div>}
    </div>
  )
}

export function FanficPanel({
  wsEvent,
  onSendToAgent,
}: {
  wsEvent: WsEvent | null
  onSendToAgent: (text: string) => void
}): React.JSX.Element {
  const [progress, setProgress] = useState<FanficProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /** 用户点步骤卡显式切换的视图；null = 跟随流程真实位置（progress.step） */
  const [view, setView] = useState<number | null>(null)

  // 欢迎表单（原著信息）
  const [srcTitle, setSrcTitle] = useState('')
  const [srcAuthor, setSrcAuthor] = useState('')
  const [srcChars, setSrcChars] = useState('')

  // 待确认草稿内容（path → 全文；面板全文展示，用户无需在聊天里展开折叠块）
  const [draftContents, setDraftContents] = useState<Record<string, string>>({})
  const draftPathsRef = useRef('')

  // 上传表单
  const fileRef = useRef<HTMLInputElement>(null)
  const [volumeNo, setVolumeNo] = useState('1')
  const [volumeLabel, setVolumeLabel] = useState('')

  // 第 1/3 步文件浏览器：分组清单 + 当前打开的资料卡（DocWorkbench 内嵌编辑）
  const [groups, setGroups] = useState<FanficFileGroup[]>([])
  const [doc, setDoc] = useState<{ card: DocCard; ai: (path: string) => string; back: string } | null>(null)

  // 第 2 步：点开的卷详情 + 时间线对比 + 分岔点
  const [volDetailId, setVolDetailId] = useState<number | null>(null)
  const [compareFile, setCompareFile] = useState('')
  const [compareMd, setCompareMd] = useState<string | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)

  // 第 3 步：打开的本书卷详情 + 勾选待确认细纲章 + 时间线对照点亮行
  const [openFicVol, setOpenFicVol] = useState<number | null>(null)
  const [checkedCh, setCheckedCh] = useState<Set<number>>(new Set())
  const [litPair, setLitPair] = useState<number | null>(null)

  // 第 2 步「新建卷纲」弹窗：勾选对应原著卷 + 本书卷名 + 预计章节数
  const [volPlanOpen, setVolPlanOpen] = useState(false)
  const [vpSel, setVpSel] = useState<Set<number>>(new Set())
  const [vpName, setVpName] = useState('')
  const [vpChapters, setVpChapters] = useState('')

  // 第 4 步：勾选要创作的已确认细纲（key = volId:ch）
  const [writeSel, setWriteSel] = useState<Set<string>>(new Set())

  const refresh = useCallback(() => {
    void fetchFanficProgress().then((p) => {
      setProgress(p)
      if (p && p.compareFiles.length > 0) {
        setCompareFile((cur) => (cur && p.compareFiles.includes(cur) ? cur : p.compareFiles[0]!))
      } else {
        setCompareFile('')
      }
      // 点开的卷被删除/未登记时收起详情
      setVolDetailId((cur) => (cur && p?.volumes.some((v) => v.id === cur) ? cur : null))
    })
    void fetchFanficFiles().then(setGroups)
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  // 原著/ 文件变更 → 刷新进度
  useEffect(() => {
    if (wsEvent?.type === 'file:changed' && wsEvent.kind === 'source') refresh()
  }, [wsEvent, refresh])

  // 草稿文件清单变化 → 拉全文（供确认展示）
  useEffect(() => {
    if (!progress) return
    const key = progress.draftFiles.map((d) => d.path).join('|')
    if (key === draftPathsRef.current) return
    draftPathsRef.current = key
    if (progress.draftFiles.length === 0) {
      setDraftContents({})
      return
    }
    void Promise.all(
      progress.draftFiles.map(async (d) => [d.path, (await fetchWorkspaceFile(d.path)) ?? '（读取失败）'] as const),
    ).then((pairs) => {
      setDraftContents(Object.fromEntries(pairs))
    })
  }, [progress])

  // 拉取选中的对比文件（含分岔点标记）
  useEffect(() => {
    if (!compareFile) {
      setCompareMd(null)
      return
    }
    setCompareLoading(true)
    void fetchWorkspaceFile(compareFile)
      .then(setCompareMd)
      .finally(() => setCompareLoading(false))
  }, [compareFile])

  // 打开本书卷详情 → 对比文件优先匹配本卷（时间线对比_第V卷.md，V=本书卷号），并重置勾选/点亮
  useEffect(() => {
    setLitPair(null)
    setCheckedCh(new Set())
    if (openFicVol == null || !progress) return
    const match = progress.compareFiles.find((f) => f.includes(`第${openFicVol}卷`))
    if (match) setCompareFile(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFicVol])

  // 第 4 步：勾选默认覆盖全部已确认细纲；已取消确认的自动移出
  useEffect(() => {
    const keys = (progress?.ficVolumes ?? []).flatMap((v) => v.confirmedChapters.map((ch) => `${v.id}:${ch}`))
    setWriteSel((prev) => {
      const kept = [...prev].filter((k) => keys.includes(k))
      return kept.length === keys.length ? prev : new Set(keys)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress])

  /** 编码检测读取：UTF-8 严格模式失败回退 GBK（网文 TXT 常见 GBK） */
  const readFileText = async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer()
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      return new TextDecoder('gbk').decode(buf)
    }
  }

  const step = progress?.step ?? 0
  const stepSub = progress?.stepSub ?? ''
  /** 欢迎形态：无进度，或第 1 步但 agent 还没拿到原著信息（meta.title 为空） */
  const welcome = !progress?.exists || (step === 1 && !progress.meta?.title)
  /** 展示页：用户显式切换优先，默认落在「设定」页——流程不再驱动页面，四步仅作导航 */
  const activeStep = view ?? 1

  /** 确认拆书卷（面板行内/详情共用）：状态落盘；缺聚合产物时通知 AI 补齐 */
  const confirmVolIds = async (ids: number[]): Promise<Record<string, string[]>> => {
    const r = await fanficConfirmVolumes(ids)
    const miss = r.missing ?? {}
    const missVols = Object.keys(miss)
    if (missVols.length > 0) {
      const files = [...new Set(missVols.flatMap((v) => miss[v] ?? []))]
      onSendToAgent(
        `我已在同人面板确认第 ${missVols.join('、')} 卷拆书，但这些卷缺 ${files.join('、')}。` +
          '请按 story-fanfic 拆书协议补齐聚合产物后继续。',
      )
    }
    refresh()
    return miss
  }

  /** 欢迎形态：开启同人创作（把面板填写的原著信息发给 Agent 走第 1 步） */
  const startFanfic = () => {
    if (!srcTitle.trim()) {
      setError('请先填写原著书名')
      return
    }
    setError('')
    onSendToAgent(
      `我要开始同人创作。原著信息——书名《${srcTitle.trim()}》` +
        (srcAuthor.trim() ? `，作者 ${srcAuthor.trim()}` : '') +
        (srcChars.trim() ? `，总字数约 ${srcChars.trim()} 万字` : '') +
        '。请按 story-fanfic 第 1 步统计原著设定：联网检索后把各项设定写入 原著/草稿/ 下的草稿文件让我在面板中确认，不要只在聊天里展示。',
    )
  }

  const submitUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('请先选择 TXT 原文文件')
      return
    }
    const vol = Number(volumeNo)
    if (!Number.isInteger(vol) || vol < 1 || vol > 99) {
      setError('卷号需为 1-99 的整数')
      return
    }
    setBusy(true)
    setError('')
    try {
      const content = await readFileText(file)
      const r = await uploadFanficSource(content, {
        filename: file.name.replace(/\.txt$/i, ''),
        volumeNo: vol,
        volumeLabel: volumeLabel.trim() || undefined,
      })
      if (fileRef.current) fileRef.current.value = ''
      setVolumeLabel('')
      refresh()
      onSendToAgent(
        `原著原文已上传：${r.path}（第 ${r.volumeNo} 卷「${r.label}」，${r.chars} 字符${r.overwrite ? '，已覆盖旧文件' : ''}）。` +
          '请按 story-fanfic 第 2 步拆书：先跑边界识别脚本 node scripts/split-source.js（只产 边界.json 行号表、不落章节文件），回填 _progress.json 的 chapters，再按事件桥段摘要（禁止逐章写摘要）。',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 当前步操作 CTA（欢迎形态不渲染；第 1 步按子阶段区分） */
  const stepCta = (): { label: string; text: string } | null => {
    if (!progress?.exists) return null
    if (step === 1) {
      return stepSub === 'own'
        ? {
            label: '继续专属设定（15 问）',
            text: '请按 story-fanfic 第 1 步（专属设定阶段）继续：用 15 问问卷分两批问我（8+7），我作答后输出设定总结让我确认，确认后落盘 设定/ 与 大纲/。',
          }
        : {
            label: '继续统计原著设定',
            text: '请按 story-fanfic 第 1 步继续统计原著设定：检索完成后把各项设定写入 原著/草稿/ 让我在面板确认。',
          }
    }
    if (step === 2) {
      return {
        label: '开始 / 继续拆书',
        text: '请按 story-fanfic 第 2 步拆书：检查 原著/原文/ 已上传的卷，先跑边界识别脚本 node scripts/split-source.js（只产 边界.json 行号表，不落章节文件、读原文按行号 Read 直读），再按事件桥段摘要——桥段划分用 原著/原著信息.md 分段表本卷各行的摘要列按顿号拆成事件（每事件一桥段；禁止整篇一段、更禁止逐章写摘要；有旧单章摘要先归并），全卷完成后聚合时间线与角色发展，我在面板确认。',
      }
    }
    if (step === 3) {
      return stepSub === 'xi'
        ? {
            label: '生成本卷细纲',
            text: '请按 story-fanfic 第 3 步（细纲阶段）：按卷纲分批生成全部细纲（大纲/细纲_第NNN章.md），逐批展示让我在面板逐章确认。',
          }
        : {
            label: '完善本卷卷纲',
            text: '请按 story-fanfic 第 3 步（卷纲阶段）：问我本卷内容/字数/时间线锚点，修订大纲、生成卷纲与时间线对比文件。',
          }
    }
    return {
      label: '进入创作（切创作模式）',
      text: '请按 story-fanfic 第 4 步交接：确认设定与细纲就绪后 switch_mode 切 write 模式开始正文创作。',
    }
  }
  const cta = welcome ? null : stepCta()

  /** 第 2 步 → 第 3 步（结构化推进 + 通知 Agent 开始卷纲问询） */
  const gotoStep3 = async () => {
    setError('')
    try {
      await fanficAdvance(3)
      refresh()
      onSendToAgent('拆书卷已确认并进入第 3 步（卷纲与细纲）。请按 story-fanfic 第 3 步：问我本卷内容/字数/时间线锚点，生成卷纲与时间线对比文件。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 第 2 步「新建卷纲」：登记本书卷（对应原著卷可多选 + 卷名 + 预计章节数）→ 进第 3 步 + 通知 Agent 生成 */
  const submitVolPlan = async () => {
    const ids = [...vpSel].sort((a, b) => a - b)
    if (ids.length === 0) {
      setError('请至少勾选一卷已拆解完成的原著卷')
      return
    }
    const ch = Number(vpChapters)
    if (!Number.isInteger(ch) || ch < 1) {
      setError('请填写本书卷预计章节数（正整数）')
      return
    }
    setError('')
    try {
      const v = await fanficVolumeCreate(vpName.trim() || `第${(progress?.ficVolumes.length ?? 0) + 1}卷`, ch, ids)
      setVolPlanOpen(false)
      setVpName('')
      setVpChapters('')
      setVpSel(new Set())
      refresh()
      setView(3)
      setOpenFicVol(v.id)
      onSendToAgent(
        `我已在同人面板登记本书第 ${v.id} 卷「${v.name}」（预计 ${v.chapters} 章，时间线基于原著第 ${v.sourceVolumes.join('、')} 卷）。` +
          `请按 story-fanfic 第 3 步卷纲阶段：基于这些卷的 拆书/时间线 与我选的分岔点（_progress.json volumes[].forkEvent），生成 ${v.dir}/卷纲.md 与 原著/时间线对比_第${v.id}卷.md（同故事时间的原著/本书事件相邻排、分岔处本书轨事件文本含「分岔点」三字），再分批生成 ${v.dir}/细纲_第NNN章.md 让我在面板逐章确认。`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 第 3 步卷详情：勾选细纲 → 确认已完善（绿色）；取消确认走行内 ✕ 按钮 */
  const confirmChapters = async (volId: number) => {
    const chs = [...checkedCh].sort((a, b) => a - b)
    if (chs.length === 0) return
    try {
      await fanficChaptersConfirm(volId, chs, true)
      setCheckedCh(new Set())
      refresh()
      // 只上报确认结果；「生成下一批细纲」由独立的「追加细纲」按钮触发，避免每次确认都误让 AI 续写
      onSendToAgent(`我已在同人面板确认本书第 ${volId} 卷的细纲第 ${chs.join('、')} 章已完善（_progress.json 已记录）。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 第 4 步：勾选已确认细纲 → 开始创作（从最小章号起，切 write 模式） */
  const startWrite = async () => {
    if (writeSel.size === 0) {
      setError('请先勾选要创作的章节')
      return
    }
    const chs = [...writeSel].map((k) => Number(k.split(':')[1])).sort((a, b) => a - b)
    setError('')
    try {
      await fanficAdvance(4)
      refresh()
      onSendToAgent(
        `我已在同人面板勾选本书第 ${chs.join('、')} 章的细纲（均已确认完善）。` +
          `请按 story-fanfic 第 4 步交接：确认 设定/题材正文提示卡.md 就绪后 switch_mode 切 write 模式，从第 ${chs[0]} 章开始按单章 13 步流程创作。`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 第 3/4 步 → 创作（结构化推进 + 通知 Agent 切模式） */
  const gotoCreate = async () => {
    setError('')
    try {
      await fanficAdvance(4)
      refresh()
      onSendToAgent('已进入第 4 步（创作）。请按 story-fanfic 第 4 步交接：确认 设定/题材正文提示卡.md 就绪后 switch_mode 切 write 模式开始正文创作。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const rows = compareMd !== null ? parseTimeline(compareMd) : null

  // 第 2 步：已拆解完成（done/confirmed）的原著卷 = 新建卷纲的候选
  const readyVols = (progress?.volumes ?? []).filter((v) => v.status === 'done' || v.status === 'confirmed')
  const confirmedVols = (progress?.volumes ?? []).filter((v) => v.status === 'confirmed')
  // 第 3 步：本书卷（ficVolumes）驱动
  const ficVols = progress?.ficVolumes ?? []
  const openFic = ficVols.find((v) => v.id === openFicVol) ?? null
  // 大纲文件：卷纲在前、细纲按章号排序
  const outlineGroup = groups.find((g) => g.key === 'outline')
  const outlineFiles = [...(outlineGroup?.files ?? [])].sort((a, b) => {
    const ka = /^卷纲/.test(a.name) ? 0 : /^大纲\.md$/.test(a.name) ? 1 : 2
    const kb = /^卷纲/.test(b.name) ? 0 : /^大纲\.md$/.test(b.name) ? 1 : 2
    if (ka !== kb) return ka - kb
    const na = Number((/\d{1,5}/.exec(a.name)?.[0] ?? 999999))
    const nb = Number((/\d{1,5}/.exec(b.name)?.[0] ?? 999999))
    return na - nb || a.name.localeCompare(b.name)
  })
  // 本书卷的章号区间（按登记顺序累加：卷1 = 1..chapters1，卷2 = chapters1+1..）
  const ficRange = openFic ? ficVolRange(ficVols, openFic.id) : ([0, 0] as const)
  // 本卷文件：新结构 = 卷目录（dir/卷纲.md、dir/细纲_第NNN章.md）；旧平铺数据（卷纲_第V卷.md）回退兼容
  const volDir = openFic?.dir ?? ''
  const chOf = (name: string): number => {
    // 文件名规范「细纲_第NNN章.md」——「第」可容缺（兼容 细纲_001章.md 形态）；
    // 卷目录内文件的 name 带目录前缀（第1卷_第一卷/细纲_第NNN章.md），先取文件名段
    const m = /^细纲_第?(\d{1,4})章/.exec(baseName(name))
    const n = m ? Number(m[1]) : NaN
    return Number.isInteger(n) ? n : NaN
  }
  const dirOutlineFile = openFic && volDir ? (outlineFiles.find((f) => f.path === `${volDir}/卷纲.md`) ?? null) : null
  const dirChFiles =
    openFic && volDir
      ? outlineFiles
          .filter((f) => f.path.startsWith(`${volDir}/细纲_`))
          .filter((f) => {
            const n = chOf(f.name)
            return Number.isInteger(n) && n >= ficRange[0] && n <= ficRange[1]
          })
          .sort((a, b) => (chOf(a.name) as number) - (chOf(b.name) as number))
      : []
  const volOutlineFile =
    dirOutlineFile ?? (openFic ? (outlineFiles.find((f) => f.name === `卷纲_第${openFic.id}卷.md`) ?? null) : null)
  const legacyChFiles =
    openFic && dirChFiles.length === 0
      ? outlineFiles.filter((f) => {
          const n = chOf(f.name)
          return Number.isInteger(n) && n >= ficRange[0] && n <= ficRange[1]
        })
      : []
  const volChFiles = dirChFiles.length > 0 ? dirChFiles : legacyChFiles

  /** 卡墙分组（「资料」同款）：第 1 步 = 原著设定 + 专属设定 */
  const settingWall = groups
    .filter((g) => g.key !== 'outline')
    .map((g) => ({ label: g.label, desc: g.desc, cards: g.files.map(toDocCard) }))

  /** 关闭文档编辑 → 回卡墙并刷新清单（编辑保存后 mtime/大小变化；WS 只监听 原著/，设定/大纲 需手动刷） */
  const closeDoc = () => {
    setDoc(null)
    refresh()
  }

  // ---------- 新建设定（弹窗输入 → 确认后自动发 Agent 执行） ----------
  const [newSettingOpen, setNewSettingOpen] = useState(false)
  const [newSettingText, setNewSettingText] = useState('')
  const [newSettingTarget, setNewSettingTarget] = useState<'auto' | 'source' | 'own'>('auto')

  const submitNewSetting = () => {
    const t = newSettingText.trim()
    if (!t) return
    const route =
      newSettingTarget === 'source'
        ? '它属于原著设定：先联网核实是否符合原著（宁缺毋滥、标注来源；查不到的部分如实向我说明），再落盘'
        : newSettingTarget === 'own'
          ? '它属于专属设定：用户钦定内容，直接采纳，无需联网核实'
          : '先判断它属于原著设定还是专属设定：涉及原著既有内容的先联网核实（宁缺毋滥、标注来源），用户原创内容直接采纳'
    onSendToAgent(
      `我要补充一条同人设定：${t}。请按 story-fanfic 第 1 步设定协议处理——${route}；` +
        '写入 设定/ 或 原著/ 下的对应文件（新文件或合并进现有文件，保持既有结构与「来源」标签行），完成后在聊天里简述写到了哪个文件、改了什么。',
    )
    setNewSettingText('')
    setNewSettingOpen(false)
  }

  /** AI 完善指令模板（第 1 步设定 / 第 3 步大纲） */
  const settingsAiPrompt = (path: string) =>
    `请完善同人设定文件 ${path}：先重读该文件与相关原著资料（原著内容宁缺毋滥、标注来源），补全空缺、修正矛盾、充实过简段落，用 Edit/Write 更新文件后在聊天里简述修改点。`
  const outlineAiPrompt = (path: string) => {
    const name = baseName(path)
    if (/^卷纲/.test(name)) {
      return `请完善卷纲文件 ${path}：对照已确认卷的 原著/拆书/时间线 与 大纲/大纲.md，校准剧情单元、时间线锚点（同人分岔点）、情绪弧线与伏笔反转，更新文件后简述修改点。`
    }
    if (/^细纲/.test(name)) {
      return `请完善细纲文件 ${path}：对照本卷卷纲与拆书时间线，补全章节定位、事件、钩子、爽点、悬念，更新文件后简述修改点。`
    }
    return `请完善大纲文件 ${path}：对照已拆书时间线与同人设定校准整体结构，更新文件后简述修改点。`
  }

  return (
    <div className="fanfic-panel">
      <div className="fanfic-head">
        <span className="fanfic-badge"><Icon name="dna" size={13} /> 同人衍生</span>
        {progress?.meta?.title && <span className="fanfic-step-text">《{progress.meta.title}》</span>}
      </div>

      {/* 四步指南（点击任意步自由查看；流程位置由 _progress.json 驱动） */}
      <div className="fanfic-steps">
        {FANFIC_STEPS.map((label, i) => {
          const no = i + 1
          const guide = FANFIC_GUIDE[i]!
          return (
            <div
              key={label}
              className={`fanfic-step${activeStep === no ? ' active' : ''}`}
              title={`${label}（点击切换页面）`}
              onClick={() => setView(no)}
            >
              <i className="fanfic-step-dot">{no}</i>
              <span className="fanfic-step-label">
                {label}
                {guide.mark && <em className="fanfic-step-mark">{guide.mark}</em>}
              </span>
            </div>
          )
        })}
      </div>

      {/* 欢迎形态：四步指南 + 原著信息输入 + 开启按钮 */}
      {welcome && (
        <div className="fanfic-guide">
          <div className="fanfic-sec-title"><Icon name="guide" size={12} /> 同人创作指南</div>
          <div className="fanfic-guide-list">
            {FANFIC_GUIDE.map((g) => (
              <div key={g.label} className="fanfic-guide-item">
                <b>
                  {g.label}
                  {g.mark && <em className="fanfic-step-mark">{g.mark}</em>}
                </b>
                <span>{g.desc}</span>
              </div>
            ))}
          </div>
          <div className="fanfic-guide-form">
            <label className="fanfic-guide-field">
              <span>原著书名 *</span>
              <input
                type="text"
                value={srcTitle}
                placeholder="如：作品名"
                onChange={(e) => setSrcTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) startFanfic()
                }}
              />
            </label>
            <label className="fanfic-guide-field">
              <span>作者</span>
              <input type="text" value={srcAuthor} placeholder="选填，如：乱" onChange={(e) => setSrcAuthor(e.target.value)} />
            </label>
            <label className="fanfic-guide-field">
              <span>总字数（万字）</span>
              <input type="text" value={srcChars} placeholder="选填，约数如 700" onChange={(e) => setSrcChars(e.target.value)} />
            </label>
          </div>
          <button type="button" className="btn-primary fanfic-guide-start" onClick={startFanfic}>
            开启同人创作
          </button>
          <div className="fanfic-tip">
            点击后 Agent 会联网检索原著设定，检索结果将以草稿形式显示在本面板第 1 步（待确认设定区），逐项由你确认是否符合原著。
          </div>
        </div>
      )}

      {/* ═══ 第 1 步：设定（待确认草稿 + 全量设定库卡墙/编辑/AI 完善） ═══ */}
      {!welcome && activeStep === 1 && (
        <div className="fanfic-sec">
          {progress && progress.draftFiles.length > 0 && (
            <div className="fanfic-drafts">
              <div className="fanfic-sec-title">
                <Icon name="file-pen" size={12} /> 待确认设定（{progress.draftFiles.length} 份草稿）
              </div>
              {progress.draftFiles.map((d) => (
                <div key={d.path} className="fanfic-draft">
                  <div className="fanfic-draft-head">
                    <b>{d.name.replace(/\.md$/, '')}</b>
                    <span className="fanfic-draft-meta">{fmtSize(d.bytes)}</span>
                  </div>
                  <pre className="fanfic-draft-content">{draftContents[d.path] ?? '加载中…'}</pre>
                </div>
              ))}
              <div className="fanfic-draft-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    onSendToAgent(
                      '我已在同人面板查看全部设定草稿，确认符合原著。请按 step1 协议正式落盘（草稿转正到 原著/ 各文件并删除草稿），然后继续专属设定（15 问）。',
                    )
                  }
                >
                  ✓ 确认符合，正式落盘
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onSendToAgent('设定草稿有偏差，我来逐项说明需要修正的地方：')}
                >
                  ✗ 有偏差（在聊天中说明）
                </button>
              </div>
            </div>
          )}

          <div className="fanfic-sec-title">
            <Icon name="folder-open" size={12} /> 设定库（与「资料」同款卡墙 · 点击查看/编辑 · 可 AI 完善）
            <button type="button" className="btn-ghost fanfic-newsetting-btn" onClick={() => setNewSettingOpen(true)}>
              ＋ 新建设定
            </button>
          </div>
          {doc ? (
            <div className="fanfic-docopen">
              <div className="fanfic-docbar">
                <button type="button" className="btn-ghost" onClick={closeDoc}>
                  ← 返回{doc.back}
                </button>
                <button type="button" className="btn-ghost" onClick={() => onSendToAgent(doc.ai(doc.card.path))}>
                  <Icon name="spark" size={11} /> AI 完善此文档
                </button>
              </div>
              <DocWorkbench card={doc.card} onClose={closeDoc} />
            </div>
          ) : (
            <FanficFileWall
              groups={settingWall}
              emptyHint="还没有设定文件——开启创作后由 Agent 检索生成，或点「＋ 新建设定」补充"
              onOpen={(card) => setDoc({ card, ai: settingsAiPrompt, back: '设定库' })}
            />
          )}

          {cta && step === 1 && (
            <div className="fanfic-cta">
              <button type="button" className="btn-primary" onClick={() => onSendToAgent(cta.text)}>
                {cta.label}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ═══ 第 2 步：拆书（上传 + 卷进度 + 卷详情：原著时间线选分岔点；此处只有原著时间线） ═══ */}
      {!welcome && activeStep === 2 && (
        <div className="fanfic-sec">
          <div className="fanfic-upload">
            <div className="fanfic-upload-title">
              <Icon name="folder-open" size={12} /> 上传原著原文（单卷 ≤2MB / 约 60 万字）
            </div>
            <div className="fanfic-upload-form">
              <input ref={fileRef} type="file" accept=".txt" className="fanfic-file" disabled={busy} />
              <input
                type="number"
                min={1}
                max={99}
                value={volumeNo}
                className="fanfic-vol-input"
                title="卷号"
                onChange={(e) => setVolumeNo(e.target.value)}
                disabled={busy}
              />
              <input
                type="text"
                value={volumeLabel}
                placeholder="卷名（选填，如 第一卷）"
                className="fanfic-vol-label"
                onChange={(e) => setVolumeLabel(e.target.value)}
                disabled={busy}
              />
              <button type="button" className="btn-ghost" onClick={() => void submitUpload()} disabled={busy}>
                {busy ? '上传中…' : '上传'}
              </button>
            </div>
            <div className="fanfic-tip">推荐逐卷上传（编码自动检测 UTF-8/GBK）；未开始拆书的卷重传会自动覆盖旧文件。</div>
          </div>

          <div className="fanfic-sec-title">
            <Icon name="hourglass" size={12} /> 拆书进度（点击卷查看详情）
            <button type="button" className="btn-ghost fanfic-newsetting-btn" onClick={() => setVolPlanOpen(true)}>
              ＋ 新建卷纲
            </button>
          </div>
          {(progress?.volumes.length ?? 0) === 0 ? (
            <div className="fanfic-tip">还没有上传任何一卷原文</div>
          ) : (
            <div className="fanfic-volumes">
              {(progress?.volumes ?? []).map((v) => {
                const pct = v.chapters > 0 ? Math.min(100, Math.round((v.summarized / v.chapters) * 100)) : 0
                const st = VOL_STATUS[v.status] ?? VOL_STATUS.pending!
                return (
                  <div key={v.id} className="fanfic-vol-row clickable" onClick={() => setVolDetailId(v.id)}>
                    <span className="fanfic-vol-name" title={v.source}>
                      第 {v.id} 卷{v.label && v.label !== `第${v.id}卷` ? `「${v.label}」` : ''}
                    </span>
                    <span className="fanfic-vol-bar">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                    <span className="fanfic-vol-count">
                      {v.summarized}/{v.chapters || '?'} 章
                    </span>
                    <span className={`fanfic-vol-status ${st.cls}`}>{st.label}</span>
                    {v.forkEvent && (
                      <span className="fanfic-vol-fork" title={`同人分岔点：${v.forkEvent}`}>
                        ⚑
                      </span>
                    )}
                    {v.status === 'done' && (
                      <button
                        type="button"
                        className="fanfic-vol-confirm"
                        title="确认本卷拆书（落盘 _progress.json）"
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmVolIds([v.id])
                        }}
                      >
                        确认
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {volDetailId !== null && (
            <VolumeDetail
              id={volDetailId}
              onSendToAgent={onSendToAgent}
              onConfirm={confirmVolIds}
              onRefresh={refresh}
              onClose={() => setVolDetailId(null)}
            />
          )}

          {confirmedVols.length > 0 && step < 3 && (
            <div className="fanfic-cta">
              <button type="button" className="btn-primary" onClick={() => void gotoStep3()}>
                ✓ 已确认 {confirmedVols.length} 卷 · 进入第 3 步：卷纲与细纲
              </button>
            </div>
          )}

          {/* 原文文件清单 */}
          {progress && progress.sourceFiles.length > 0 && (
            <div className="fanfic-files">
              <div className="fanfic-sec-title"><Icon name="file-text" size={12} /> 原文文件（{progress.sourceFiles.length}）</div>
              {progress.sourceFiles.map((f) => (
                <div key={f.path} className="fanfic-file-row" title={f.path}>
                  <span className="fanfic-file-name">{f.name}</span>
                  <span className="fanfic-file-meta">{fmtSize(f.bytes)}</span>
                </div>
              ))}
            </div>
          )}

          {cta && step === 2 && (
            <div className="fanfic-cta">
              <button type="button" className="btn-primary" onClick={() => onSendToAgent(cta.text)}>
                {cta.label}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ═══ 第 3 步：卷纲与细纲（核心：本书卷列表 → 卷详情：时间线对照/卷纲/细纲逐章确认） ═══ */}
      {!welcome && activeStep === 3 && (
        <div className="fanfic-sec">
          <div className="fanfic-sec-title">
            <Icon name="spark" size={12} /> 卷纲与细纲 <em className="fanfic-step-mark">核心</em>
          </div>
          <div className="fanfic-tip">
            先在第 2 步拆书页点「＋ 新建卷纲」登记本书卷（勾选对应的原著卷）；点开卷详情对照时间线、编辑卷纲与细纲，勾选已完善的细纲章确认（变绿）后进入创作。
          </div>

          {doc ? (
            <div className="fanfic-docopen">
              <div className="fanfic-docbar">
                <button type="button" className="btn-ghost" onClick={closeDoc}>
                  ← 返回{doc.back}
                </button>
                <button type="button" className="btn-ghost" onClick={() => onSendToAgent(doc.ai(doc.card.path))}>
                  <Icon name="spark" size={11} /> AI 完善此文档
                </button>
              </div>
              <DocWorkbench card={doc.card} onClose={closeDoc} />
            </div>
          ) : openFic ? (
            <div className="fanfic-ficdetail">
              <div className="fanfic-ficdetail-head">
                <button type="button" className="btn-ghost" onClick={() => setOpenFicVol(null)}>
                  ← 返回卷列表
                </button>
                <b>
                  第 {openFic.id} 卷「{openFic.name}」
                </b>
                <span className="fanfic-ficvol-meta">
                  基于原著第 {openFic.sourceVolumes.join('、')} 卷 · 预计 {openFic.chapters} 章（第 {ficRange[0]}
                  {ficRange[1] > ficRange[0] ? `-${ficRange[1]}` : ''} 章）· 细纲已确认 {openFic.confirmedChapters.length} 章
                </span>
              </div>

              {/* 时间线对照：同故事时间原著/本书并排一行；点击一侧 → 两侧同亮 */}
              {progress && progress.compareFiles.length > 0 && (
                <div className="fanfic-timeline">
                  <div className="fanfic-sec-title">
                    <Icon name="shuffle" size={12} /> 时间线对照（原著 vs 本书）
                    <select
                      className="fanfic-compare-select"
                      value={compareFile}
                      onChange={(e) => setCompareFile(e.target.value)}
                    >
                      {progress.compareFiles.map((f) => (
                        <option key={f} value={f}>
                          {f.replace(/^原著\//, '').replace(/\.md$/, '')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="fanfic-tip">点击任意一行的时间或事件，两侧同时点亮——一眼对应同一故事时间的原著 / 本书剧情。</div>
                  {compareLoading ? (
                    <div className="fanfic-tip">加载中…</div>
                  ) : rows ? (
                    <div className="fanfic-pairs">
                      <div className="fanfic-pair-row fanfic-pair-head">
                        <span className="fanfic-pair-time">故事时间</span>
                        <span className="fanfic-pair-cell">原著</span>
                        <span className="fanfic-pair-cell">本书</span>
                      </div>
                      {pairTimelineRows(rows).map((p, i) => (
                        <div
                          key={`p${i}`}
                          className={`fanfic-pair-row${p.fork ? ' fork' : ''}${litPair === i ? ' lit' : ''}`}
                          onClick={() => setLitPair(litPair === i ? null : i)}
                        >
                          <span className="fanfic-pair-time">{p.time}</span>
                          <span className="fanfic-pair-cell orig">{p.orig.length > 0 ? p.orig.join('；') : '—'}</span>
                          <span className="fanfic-pair-cell fic">
                            {p.fic.length > 0 ? (
                              <>
                                {p.fork ? '⚑ ' : ''}
                                {p.fic.join('；')}
                              </>
                            ) : (
                              '—'
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : compareMd !== null ? (
                    <pre className="fanfic-compare-raw">{compareMd.slice(0, 2000)}</pre>
                  ) : (
                    <div className="fanfic-tip">对比文件读取失败</div>
                  )}
                </div>
              )}

              {/* 卷纲 */}
              <div className="fanfic-sec-title"><Icon name="file-text" size={12} /> 本卷卷纲</div>
              {volOutlineFile ? (
                <button
                  type="button"
                  className="fanfic-ch-row fanfic-ch-row-btn"
                  onClick={() => setDoc({ card: toDocCard(volOutlineFile), ai: outlineAiPrompt, back: '卷详情' })}
                >
                  <span className="fanfic-ch-name">{volOutlineFile.name.replace(/\.md$/, '')}</span>
                  <span className="fanfic-ch-status">点击查看 / 编辑</span>
                </button>
              ) : (
                <div className="fanfic-tip">本卷卷纲还没有生成（{volDir}/卷纲.md）——点下方按钮让 AI 生成</div>
              )}

              {/* 细纲逐章：勾选 → 确认已完善（绿色） */}
              <div className="fanfic-sec-title">
                <Icon name="file-pen" size={12} /> 本卷细纲（{ficRange[0]}
                {ficRange[1] > ficRange[0] ? `-${ficRange[1]}` : ''} 章 · 勾选已完善的章节后点确认）
              </div>
              {volChFiles.length === 0 ? (
                <div className="fanfic-tip">本卷细纲还没有生成——点下方按钮让 AI 按卷纲分批生成</div>
              ) : (
                <div className="fanfic-chapters">
                  {volChFiles.map((f) => {
                    const ch = chOf(f.name)
                    const ok = openFic.confirmedChapters.includes(ch)
                    return (
                      <div key={f.path} className={`fanfic-ch-row${ok ? ' confirmed' : ''}`}>
                        {!ok && (
                          <input
                            type="checkbox"
                            checked={checkedCh.has(ch)}
                            onChange={() =>
                              setCheckedCh((prev) => {
                                const n = new Set(prev)
                                if (n.has(ch)) n.delete(ch)
                                else n.add(ch)
                                return n
                              })
                            }
                          />
                        )}
                        <button
                          type="button"
                          className="fanfic-ch-name"
                          title={`打开编辑：${f.path}`}
                          onClick={() => setDoc({ card: toDocCard(f), ai: outlineAiPrompt, back: '卷详情' })}
                        >
                          {f.name.replace(/\.md$/, '')}
                        </button>
                        <span className="fanfic-ch-status">{ok ? '✓ 已完善' : checkedCh.has(ch) ? '待确认' : '未确认'}</span>
                        {ok && (
                          <button
                            type="button"
                            className="fanfic-vol-close"
                            title="取消确认"
                            onClick={() => {
                              void fanficChaptersConfirm(openFic.id, [ch], false).then(refresh)
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {checkedCh.size > 0 && (
                <div className="fanfic-cta">
                  <button type="button" className="btn-primary" onClick={() => void confirmChapters(openFic.id)}>
                    ✓ 确认 {checkedCh.size} 章细纲已完善（变绿）
                  </button>
                </div>
              )}

              <div className="fanfic-cta">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    onSendToAgent(
                      `请按 story-fanfic 第 3 步继续本书第 ${openFic.id} 卷「${openFic.name}」的卷纲与细纲：` +
                        `对照原著第 ${openFic.sourceVolumes.join('、')} 卷的时间线与已确认的细纲章（_progress.json ficVolumes），` +
                        `缺卷纲/时间线对比先补生成，细纲按卷纲分批生成（${volDir}/细纲_第NNN章.md），完成后我在面板逐章确认。`,
                    )
                  }
                >
                  ✦ AI 生成本卷卷纲与细纲
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    onSendToAgent(
                      `请按 story-fanfic 第 3 步为本书第 ${openFic.id} 卷「${openFic.name}」追加细纲：` +
                        `对照 ${volDir}/卷纲.md，从已有细纲文件的下一章继续分批生成（${volDir}/细纲_第NNN章.md，` +
                        `已确认的章节不覆盖），完成后我在面板逐章确认；若第 ${ficRange[0]}${ficRange[1] > ficRange[0] ? `-${ficRange[1]}` : ''} 章细纲已全部生成，提示我可进入创作。`,
                    )
                  }
                >
                  ＋ 追加细纲（AI 生成下一批）
                </button>
                <button type="button" className="btn-ghost" onClick={() => void gotoCreate()}>
                  进入创作（第 4 步）
                </button>
              </div>
            </div>
          ) : ficVols.length === 0 ? (
            <div className="fanfic-tip">
              还没有登记本书卷——请到第 2 步拆书页点「＋ 新建卷纲」：勾选本书第一卷时间线对应的原著卷（可多选），填好卷名与预计章节数即可。
            </div>
          ) : (
            <div className="fanfic-ficvols">
              <div className="fanfic-tip">点击卷进入详情：时间线对照 / 卷纲 / 细纲逐章确认</div>
              {ficVols.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="fanfic-ficvol"
                  onClick={() => {
                    setOpenFicVol(v.id)
                    setLitPair(null)
                    setCheckedCh(new Set())
                  }}
                >
                  <b>
                    第 {v.id} 卷「{v.name}」
                  </b>
                  <span>基于原著第 {v.sourceVolumes.join('、')} 卷</span>
                  <span className={v.confirmedChapters.length > 0 ? 'ok' : ''}>细纲 {v.confirmedChapters.length}/{v.chapters} 章已确认</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ 第 4 步：创作 ═══ */}
      {!welcome && activeStep === 4 && (
        <div className="fanfic-sec">
          <div className="fanfic-sec-title">
            <Icon name="spark" size={12} /> 创作 <em className="fanfic-step-mark">产出</em>
          </div>
          {(() => {
            const ready = ficVols.flatMap((v) => v.confirmedChapters)
            if (ready.length === 0) {
              return (
                <div className="fanfic-tip">
                  还没有已确认完善的细纲——请先在第 3 步卷详情里勾选细纲章并点「确认已完善」（变绿后出现在这里）。
                </div>
              )
            }
            return (
              <>
                <div className="fanfic-tip">
                  勾选要创作的章节（已确认细纲，默认全选），点击开始创作——AI 从所选最小章号起按单章 13 步流程推进（读细纲 → 写前准备 → 写作 → 质检 → 追踪）。
                </div>
                <div className="fanfic-writech">
                  {ficVols.map((v) =>
                    v.confirmedChapters.length === 0 ? null : (
                      <div key={v.id} className="fanfic-writevol">
                        <div className="fanfic-writevol-name">
                          第 {v.id} 卷「{v.name}」
                        </div>
                        {v.confirmedChapters.map((ch) => {
                          const key = `${v.id}:${ch}`
                          return (
                            <label key={key} className="fanfic-writech-item">
                              <input
                                type="checkbox"
                                checked={writeSel.has(key)}
                                onChange={() =>
                                  setWriteSel((prev) => {
                                    const n = new Set(prev)
                                    if (n.has(key)) n.delete(key)
                                    else n.add(key)
                                    return n
                                  })
                                }
                              />
                              <span>第 {ch} 章</span>
                            </label>
                          )
                        })}
                      </div>
                    ),
                  )}
                </div>
                <div className="fanfic-cta">
                  <button type="button" className="btn-primary" onClick={() => void startWrite()}>
                    ✓ 开始创作（已勾选 {writeSel.size} 章）
                  </button>
                </div>
              </>
            )
          })()}
          <div className="fanfic-tip">
            每写 2-3 章建议新开会话，输入「继续同人」即可从断点恢复；下一卷原著上传后回第 2 步循环拆书。
          </div>
        </div>
      )}

      {/* 新建设定弹窗：用户补充设定 → 确认后自动发 Agent 执行（判归属 → 落盘 → 汇报） */}
      {newSettingOpen && (
        <div className="modal-mask" onClick={() => setNewSettingOpen(false)}>
          <div className="fanfic-newsetting" onClick={(e) => e.stopPropagation()}>
            <div className="fanfic-newsetting-head">
              <b>新建设定</b>
              <button type="button" className="fanfic-vol-close" title="关闭" onClick={() => setNewSettingOpen(false)}>
                ✕
              </button>
            </div>
            <div className="fanfic-newsetting-body">
              <textarea
                className="fanfic-newsetting-text"
                autoFocus
                placeholder={'补充一条设定，如：\n· 金手指：随身携带可回溯三息的能力\n· 穿越时点：原著第 12 章主角入学当天\n· 新角色：主角的表妹「〈新角色名〉」，同辈弟子'}
                value={newSettingText}
                onChange={(e) => setNewSettingText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNewSettingOpen(false)
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitNewSetting()
                }}
              />
              <label className="fanfic-newsetting-target">
                <span>归属</span>
                <select
                  value={newSettingTarget}
                  onChange={(e) => setNewSettingTarget(e.target.value as typeof newSettingTarget)}
                >
                  <option value="auto">自动判断（推荐）</option>
                  <option value="source">原著设定（AI 先核实，宁缺毋滥）</option>
                  <option value="own">专属设定（用户钦定，直接采纳）</option>
                </select>
                <span className="fanfic-newsetting-hint">Ctrl+Enter 直接发送</span>
              </label>
              <div className="fanfic-tip">确认后自动发送给 AI：它会写入对应文件（新增或合并），完成后在聊天里汇报落盘结果。</div>
            </div>
            <div className="fanfic-newsetting-foot">
              <button type="button" className="btn-ghost" onClick={() => setNewSettingOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" disabled={!newSettingText.trim()} onClick={submitNewSetting}>
                确认并发送
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建卷纲弹窗（拆书页）：勾选本书卷对应的原著卷（可多选）+ 卷名 + 预计章节数 → 登记 ficVolumes + 通知 AI 生成 */}
      {volPlanOpen && (
        <div className="modal-mask" onClick={() => setVolPlanOpen(false)}>
          <div className="fanfic-newsetting" onClick={(e) => e.stopPropagation()}>
            <div className="fanfic-newsetting-head">
              <b>新建卷纲（登记本书卷）</b>
              <button type="button" className="fanfic-vol-close" title="关闭" onClick={() => setVolPlanOpen(false)}>
                ✕
              </button>
            </div>
            <div className="fanfic-newsetting-body">
              <div className="fanfic-newsetting-target"><span>对应原著卷（可多选）</span></div>
              <div className="fanfic-vpsel">
                {readyVols.length === 0 && <div className="fanfic-tip">还没有拆解完成的原著卷——先上传原文并完成拆书</div>}
                {readyVols.map((v) => (
                  <label key={v.id} className={`fanfic-vpchip${vpSel.has(v.id) ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={vpSel.has(v.id)}
                      onChange={() =>
                        setVpSel((prev) => {
                          const n = new Set(prev)
                          if (n.has(v.id)) n.delete(v.id)
                          else n.add(v.id)
                          return n
                        })
                      }
                    />
                    <span>
                      第 {v.id} 卷{v.label && v.label !== `第${v.id}卷` ? `「${v.label}」` : ''}（{v.summarized}/{v.chapters || '?'} 章）
                    </span>
                  </label>
                ))}
              </div>
              <label className="fanfic-newsetting-target">
                <span>本书卷名</span>
                <input
                  type="text"
                  value={vpName}
                  placeholder={`如：第一卷（默认 第${(progress?.ficVolumes.length ?? 0) + 1}卷）`}
                  onChange={(e) => setVpName(e.target.value)}
                />
              </label>
              <label className="fanfic-newsetting-target">
                <span>预计章节数</span>
                <input
                  type="number"
                  min={1}
                  value={vpChapters}
                  placeholder="如 45（决定本卷细纲章号区间）"
                  onChange={(e) => setVpChapters(e.target.value)}
                />
              </label>
              <div className="fanfic-tip">确认后进入第 3 步并通知 AI 生成本卷卷纲、时间线对比与逐章细纲。</div>
            </div>
            <div className="fanfic-newsetting-foot">
              <button type="button" className="btn-ghost" onClick={() => setVolPlanOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={() => void submitVolPlan()}>
                确认并创建
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="fanfic-error">{error}</div>}
    </div>
  )
}
