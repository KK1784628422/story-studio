/**
 * 资料卡墙（大纲/设定/追踪 分组卡片）：点击卡片 → onOpenDoc 回调（可视化栏内编辑，不再弹窗）。
 * 「设定」页顶部嵌人物关系网（RelNet，数据源 设定/关系.md）；卡片附大小/更新时间 meta；
 * 设定·角色 卡片支持右键「上传头像」（写 设定/头像/，广播 relnet:avatar 刷新关系网）。
 */
import { useEffect, useRef, useState } from 'react'
import type { DocCard, DocSection } from '@story-studio/shared'
import { avatarUrl, uploadAvatar } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { charColorOf, RelNet, docAgo } from './RelNet.tsx'

interface Props {
  section?: DocSection
  loading: boolean
  kindLabel: string
  onOpenDoc: (card: DocCard) => void
  /** 关系网空态「让 Agent 补建」：转发给 Agent 的发送通道（App → WorkPanel 注入） */
  onSendToAgent?: (text: string) => void
}

/** 字节 → 可读大小 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

export function CardsView({ section, loading, kindLabel, onOpenDoc, onSendToAgent }: Props) {
  /** 角色卡右键上传头像：菜单 + 隐藏文件选择器（上传后广播 relnet:avatar 刷新关系网） */
  const [avMenu, setAvMenu] = useState<{ x: number; y: number; card: DocCard } | null>(null)
  const [avErr, setAvErr] = useState('')
  const avFileRef = useRef<HTMLInputElement>(null)
  const avPendingRef = useRef('')
  /** 角色卡 Medallion 头像：版本号穿透缓存 + 404 名字回退首字 */
  const [cardAvVer, setCardAvVer] = useState(0)
  const [cardAvFail, setCardAvFail] = useState<Set<string>>(new Set())

  useEffect(() => {
    const onUp = (): void => {
      setCardAvVer((v) => v + 1)
      setCardAvFail(new Set())
    }
    window.addEventListener('relnet:avatar', onUp)
    return () => window.removeEventListener('relnet:avatar', onUp)
  }, [])

  useEffect(() => {
    if (!avMenu) return
    // 注意：菜单项的 click 之前会先触发 window pointerdown——
    // 点在菜单内部时不关闭，否则菜单先卸载、click 永远不会触发（“上传无效果”根因）
    const close = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.av-menu')) return
      setAvMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAvMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [avMenu])

  const onPickAvatar = async (file: File | undefined): Promise<void> => {
    const name = avPendingRef.current
    if (!file || !name) return
    const res = await uploadAvatar(name, file)
    if (res.ok) {
      setAvErr('')
      window.dispatchEvent(new CustomEvent('relnet:avatar'))
    } else {
      setAvErr(`${name}：${res.error ?? '上传失败'}`)
    }
  }

  if (loading) return <div className="cards-loading">正在装载…</div>

  if (!section?.exists || section.groups.length === 0) {
    return (
      <div className="cards-empty">
        <h2>{kindLabel}</h2>
        <p>当前没有可展示的文档。</p>
      </div>
    )
  }

  return (
    <div className="cards-view">
      {/* 人物关系网：仅「设定」页展示（数据源 设定/关系.md；权重 = 角色 md 文件大小） */}
      {kindLabel === '设定' && <RelNet section={section} onOpenDoc={onOpenDoc} onSendToAgent={onSendToAgent} />}
      <header className="cards-head">
        <h2>{kindLabel}</h2>
        <span className="cards-count">
          {section.groups.reduce((n, g) => n + g.cards.length, 0)} 份文档
          {section.readOnly ? ' · 只读' : ''}
        </span>
      </header>
      {section.groups.map((g) => (
        <section key={g.group} className="card-group">
          <h3 className="card-group-title">{g.group}</h3>
          <div className="card-grid">
            {g.cards.map((card) => {
              const isChar = kindLabel === '设定' && g.group === '角色'
              const cname = card.name.replace(/\.md$/, '')
              const avSrc = cardAvFail.has(cname) ? null : avatarUrl(cname, cardAvVer)
              return (
                <button
                  key={card.path}
                  className={`doc-card${isChar ? ' char' : ''}`}
                  onClick={() => onOpenDoc(card)}
                  title={`打开编辑：${card.path}`}
                  onContextMenu={(ev) => {
                    // 设定·角色 卡右键 → 上传头像菜单（名字即角色名）
                    if (isChar) {
                      ev.preventDefault()
                      setAvMenu({ x: ev.clientX, y: ev.clientY, card })
                    }
                  }}
                >
                  {isChar ? (
                    <>
                      <i className="wc-corner tl" />
                      <i className="wc-corner tr" />
                      <i className="wc-corner bl" />
                      <i className="wc-corner br" />
                      <span className="wc-title">{cname}</span>
                      <span className="wc-medal" style={{ color: charColorOf(cname) }}>
                        {avSrc ? (
                          <img
                            src={avSrc}
                            alt={cname}
                            onError={() =>
                              setCardAvFail((prev) => {
                                const next = new Set(prev)
                                next.add(cname)
                                return next
                              })
                            }
                          />
                        ) : (
                          <b>{cname[0]}</b>
                        )}
                      </span>
                      {/* hover 卡片内部上方展开的大图（覆盖标题/徽章区，金角框在外圈保持可见） */}
                      <span className="wc-expand" aria-hidden>
                        {avSrc ? <img src={avSrc} alt="" /> : <b style={{ background: charColorOf(cname) }}>{cname[0]}</b>}
                        <i>{cname}</i>
                      </span>
                      <span className="wc-stats">
                        <span className="wc-stat">
                          <i>FILE</i>
                          <b>{card.name}</b>
                        </span>
                        <span className="wc-stat">
                          <i>SIZE</i>
                          <b>{card.bytes != null ? fmtSize(card.bytes) : '—'}</b>
                        </span>
                        <span className="wc-stat">
                          <i>UPDATED</i>
                          <b>{card.mtime != null ? docAgo(card.mtime) : '—'}</b>
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={`doc-card-kind ${card.kind}`}>{card.kind === 'json' ? '{}' : 'MD'}</span>
                      <span className="doc-card-title">{card.title}</span>
                      <span className="doc-card-file">{card.name}</span>
                      {(card.bytes != null || card.mtime != null) && (
                        <span className="doc-card-meta">
                          {card.bytes != null ? fmtSize(card.bytes) : ''}
                          {card.bytes != null && card.mtime != null ? ' · ' : ''}
                          {card.mtime != null ? docAgo(card.mtime) : ''}
                        </span>
                      )}
                    </>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      ))}
      <div className="cards-hint">
        <Icon name="pencil" size={12} /> 点击卡片在「文档编辑」页内查看 / 编辑 · 角色卡右键可上传头像
      </div>
      {avMenu && (
        <>
          <div className="av-menu-mask" />
          <div className="av-menu" style={{ left: avMenu.x, top: avMenu.y }}>
            <div className="av-menu-name">{avMenu.card.title ?? avMenu.card.name}</div>
            <button
              type="button"
              className="av-menu-item"
              onClick={() => {
                avPendingRef.current = (avMenu.card.title ?? avMenu.card.name).replace(/\.md$/, '')
                avFileRef.current?.click()
                setAvMenu(null)
              }}
            >
              <Icon name="file-fetch" size={13} /> 上传头像…
            </button>
          </div>
        </>
      )}
      <input
        ref={avFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(ev) => {
          void onPickAvatar(ev.target.files?.[0])
          ev.target.value = ''
        }}
      />
      {avErr && <div className="av-err">⚠ {avErr}</div>}
    </div>
  )
}
