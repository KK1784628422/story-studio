/**
 * 追踪面板：_tracking-state.json 权威数据的前端视图。
 * 四标签：角色状态快照 / 伏笔台账 / 时间线 / 章节记录 + 续写上下文概要。
 * WS tracking:updated / file:changed(追踪) 触发刷新。
 */
import { useEffect, useState } from 'react'
import type { TrackingPanelData, WsEvent } from '@story-studio/shared'
import { fetchTracking } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

type Tab = 'characters' | 'foreshadows' | 'timeline' | 'chapters'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'characters', label: '角色状态' },
  { id: 'foreshadows', label: '伏笔台账' },
  { id: 'timeline', label: '时间线' },
  { id: 'chapters', label: '章节记录' },
]

export function TrackingPanel({ wsEvent }: { wsEvent: WsEvent | null }) {
  const [data, setData] = useState<TrackingPanelData | null>(null)
  const [tab, setTab] = useState<Tab>('characters')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      setData(await fetchTracking())
    } catch {
      // 服务未就绪
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!wsEvent) return
    if (wsEvent.type === 'tracking:updated' || (wsEvent.type === 'file:changed' && wsEvent.kind === 'tracking')) {
      void refresh()
    }
  }, [wsEvent])

  if (loading) return <div className="cards-loading">正在装载追踪状态…</div>
  if (!data) {
    return (
      <div className="cards-empty">
        <h2>追踪</h2>
        <p>未找到 追踪/_tracking-state.json（新书尚未初始化追踪体系）。</p>
      </div>
    )
  }

  return (
    <div className="tracking-panel">
      <header className="cards-head">
        <h2>追踪</h2>
        <span className="cards-count">
          rev {data.revision ?? '—'} · 已提交至第 {data.lastCommittedChapter ?? '—'} 章
        </span>
      </header>

      {data.context.volume && (
        <div className="tracking-context">
          <span className="tc-chip">📗 {data.context.volume}</span>
          {data.context.storyTime && (
            <span className="tc-chip"><Icon name="clock" size={12} /> {data.context.storyTime}</span>
          )}
          {data.context.scene && (
            <span className="tc-chip"><Icon name="film" size={12} /> {data.context.scene}</span>
          )}
          {data.context.activeCharacterNames.length > 0 && (
            <span className="tc-chip"><Icon name="users" size={12} /> {data.context.activeCharacterNames.join('、')}</span>
          )}
        </div>
      )}
      {(data.context.continuityRisks.length > 0 || data.context.nextChapterCommitments.length > 0) && (
        <div className="tracking-notes">
          {data.context.continuityRisks.length > 0 && (
            <div className="tn-row">
              <b>连贯性风险</b>
              <ul>
                {data.context.continuityRisks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {data.context.nextChapterCommitments.length > 0 && (
            <div className="tn-row">
              <b>下一章承诺</b>
              <ul>
                {data.context.nextChapterCommitments.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="tracking-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tt-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tracking-body">
        {tab === 'characters' &&
          (data.characters.length === 0 ? (
            <Empty text="暂无角色快照" />
          ) : (
            data.characters.map((c) => (
              <div key={c.name} className="tk-card">
                <button
                  type="button"
                  className="tk-head"
                  onClick={() => setExpanded(expanded === c.name ? null : c.name)}
                >
                  <span className="tk-name">{c.name}</span>
                  <span className="tk-sub">{c.identity}</span>
                  {c.updatedChapter != null && <span className="tk-chip">第{c.updatedChapter}章</span>}
                  <span className="tk-caret">{expanded === c.name ? '▾' : '▸'}</span>
                </button>
                {expanded === c.name && (
                  <div className="tk-detail">
                    <Field label="状态" text={c.state} />
                    <Field label="位置" text={c.location} />
                    <Field label="目标" text={c.goal} />
                    {c.abilities.length > 0 && <Field label="能力/资源" list={c.abilities} />}
                    {c.knowledge.length > 0 && <Field label="已知信息" list={c.knowledge} />}
                    {c.openThreads.length > 0 && <Field label="未回收线头" list={c.openThreads} />}
                    {c.relationships.length > 0 && <Field label="关系" list={c.relationships} />}
                  </div>
                )}
              </div>
            ))
          ))}

        {tab === 'foreshadows' &&
          (data.foreshadows.length === 0 ? (
            <Empty text="暂无伏笔" />
          ) : (
            <table className="tk-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>伏笔</th>
                  <th>状态</th>
                  <th>埋设</th>
                  <th>计划回收</th>
                  <th>重要度</th>
                </tr>
              </thead>
              <tbody>
                {data.foreshadows.map((f) => (
                  <tr key={f.id} className={`fs-${f.status}`}>
                    <td className="mono">{f.id}</td>
                    <td>{f.summary}</td>
                    <td>
                      <span className={`fs-badge ${f.status}`}>{f.status}</span>
                    </td>
                    <td className="mono">{f.plantedChapter ?? '—'}</td>
                    <td className="mono">{f.plannedResolution ?? '—'}</td>
                    <td>{f.importance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        {tab === 'timeline' &&
          (data.timeline.length === 0 ? (
            <Empty text="暂无时间线事件" />
          ) : (
            data.timeline.map((t) => (
              <div key={t.id} className={`tl-item rv-${t.revealStatus}`}>
                <div className="tl-head">
                  <span className="mono tl-id">{t.id}</span>
                  <span className="tl-time">{t.storyTime}</span>
                  <span className={`rv-badge ${t.revealStatus}`}>
                    {t.revealStatus}
                    {t.revealChapter != null ? `·${t.revealChapter}章` : ''}
                  </span>
                </div>
                <div className="tl-fact">{t.objectiveFact}</div>
                {t.readerKnowledge && t.readerKnowledge !== t.objectiveFact && (
                  <div className="tl-reader">读者已知：{t.readerKnowledge}</div>
                )}
                {t.characters.length > 0 && (
                  <div className="tl-chars">{t.characters.join(' · ')}</div>
                )}
              </div>
            ))
          ))}

        {tab === 'chapters' &&
          (data.chapterRecords.length === 0 ? (
            <Empty text="暂无逐章记录" />
          ) : (
            <div className="tk-records">
              {data.chapterRecords.map((f) => (
                <span key={f} className="tk-record-chip">
                  {f.replace(/\.md$/, '')}
                </span>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="cards-empty small">{text}</div>
}

function Field({ label, text, list }: { label: string; text?: string; list?: string[] }) {
  if (!text && (!list || list.length === 0)) return null
  return (
    <div className="tk-field">
      <span className="tk-field-label">{label}</span>
      {list ? (
        <ul>
          {list.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : (
        <span>{text}</span>
      )}
    </div>
  )
}
