/**
 * 人物关系网（讨论模式 · 资料页·设定顶部）：数据源 = 设定/关系.md（用户拍板）。
 * - 解析「- A & B：描述」条目（全/半角冒号、&/×/vs 分隔兼容），实体 = 关系对两侧名字；
 * - 权重 = 设定/角色/{名字}.md 的文件字节数：**文件越大越靠中心、头像越大**；
 *   无角色文件者（势力/系统/未建卡角色）为外侧小节点（虚线描边）；
 * - 头像 = 图片（/api/avatar，右键节点上传）或彩色底+首字回退；名字全称显示在头像下方（超宽自动压缩，不溢出）；
 * - 关系线连接所有解析出的条目，悬停显示描述；点击角色节点打开其设定卡（无卡回退追踪卡）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocCard, DocSection } from '@story-studio/shared'
import { avatarUrl, fetchDoc, uploadAvatar } from '../api.ts'
import { Icon } from '../components/Icon.tsx'

const W = 660
const H = 420

interface Ent {
  name: string
  bytes: number
  isChar: boolean
  x: number
  y: number
  r: number
  color: string
}
interface Rel {
  a: number
  b: number
  label: string
}

/** 名字 → 稳定颜色（灰金紫青玫瑰调色板取模，节点间区分度高）；角色卡片头像底色复用 */
const PALETTE = ['#d0a75a', '#8b7fd6', '#5ab8a8', '#d67f9e', '#7fb5d6', '#b5a26b', '#c98bd6', '#6bbf8f']
function colorOf(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return PALETTE[h % PALETTE.length]!
}
export function charColorOf(name: string): string {
  return colorOf(name)
}

/** 相对时间 */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

/** 图片头像：约定 `设定/头像/{名字}.{png|jpg|webp|gif}`，经 /api/avatar 读写（服务端就绪，右键即可上传） */

/**
 * 解析关系.md，兼容三种写法（真实书为表格格式）：
 * 1. 表格：| 角色 A | 角色 B | 关系类型 | … |（跳过表头/分隔行；label=关系类型列，可拼情感倾向）
 * 2. 列表：- A & B：描述（&/×/vs 分隔，全/半角冒号）
 * 3. 段落：A <-> B：标题（label 取冒号后文字，可空）
 */
function parseRelations(md: string): Array<{ a: string; b: string; label: string }> {
  const out: Array<{ a: string; b: string; label: string }> = []
  const push = (a: string, b: string, label: string): void => {
    const na = a.trim()
    const nb = b.trim()
    if (!na || !nb || na === nb) return
    if (out.some((r) => (r.a === na && r.b === nb) || (r.a === nb && r.b === na))) return // A→B/B→A 去重
    out.push({ a: na, b: nb, label: label.trim().slice(0, 26) })
  }
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // 1) 表格行
    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c, i, arr) => !(c === '' && (i === 0 || i === arr.length - 1)))
      // 去掉首尾空 cell 后：cells[0]=A, cells[1]=B, cells[2]=关系类型, cells[3]=情感倾向
      if (cells.length < 3) continue
      const [a, b, type, mood] = cells as string[]
      if (!a || !b) continue
      if (/^[-—\s]+$/.test(a) || a.includes('角色') || b.includes('角色')) continue // 分隔行/表头
      push(a, b, [type, mood].filter(Boolean).join(' · '))
      continue
    }
    // 2) 段落标题：A <-> B：…（按 <-> 切分；B 取到冒号/行尾，避免懒惰正则只吃一个字产生「沈/曹/赵」幽灵实体）
    if (line.includes('<->')) {
      const idx = line.indexOf('<->')
      const head = line.slice(0, idx).trim()
      const rest = line.slice(idx + 3)
      const ci = rest.search(/[：:]/)
      const b = (ci >= 0 ? rest.slice(0, ci) : rest).trim()
      const label = ci >= 0 ? rest.slice(ci + 1).trim() : ''
      push(head, b, label)
      continue
    }
    // 3) 列表行：- A & B：描述
    if (line.startsWith('-') || line.startsWith('*')) {
      const body = line.replace(/^[-*]\s+/, '')
      const cm = /^([^：:]{1,40})[：:]\s*(.+)$/.exec(body)
      if (!cm) continue
      const pair = cm[1]!.trim().split(/\s*(?:&|×|vs)\s*/).map((s) => s.trim()).filter(Boolean)
      if (pair.length !== 2) continue
      push(pair[0]!, pair[1]!, cm[2]!.trim())
    }
  }
  return out
}

/** 空态「让 Agent 补建」发出的指令：明确表格格式（parseRelations 按此解析）+ 纯角色名约束 */
const RELNET_BUILD_PROMPT = `请为本书补建《设定/关系.md》：先读 设定/角色/ 下的角色卡（无角色卡则从设定与已有正文中提取主要人物并同步补建角色卡），然后创建/修订 设定/关系.md，必须含如下格式的「关系总览」表格（前端人物关系网按它逐行解析，格式不符图谱为空）：

| 角色 A | 角色 B | 关系类型 | 情感倾向 | 当前状态 | 起始章节 | 变化节点 |
|--------|--------|----------|----------|----------|----------|----------|
| {角色名} | {角色名} | {亲情/爱情/友情/敌对/师生/主从/利益} | {正面/负面/中性/复杂} | {一句话} | 第{N}章 | {事件} |

要求：前两列必须是纯角色名（与 设定/角色/{角色名}.md 文件名一致，不加身份/修饰词），每对主要角色一行；表格之外可附「关系演变」「核心冲突关系」小节，但关系对不要在表外重复罗列。`

export function RelNet({
  section,
  onOpenDoc,
  onSendToAgent,
}: {
  /** 设定 DocSection：提供 角色/ 组卡片（名字 → 文件字节数 → 权重/头像大小/居中程度） */
  section?: DocSection
  onOpenDoc: (card: DocCard) => void
  /** 空态「让 Agent 补建」：发送补建指令到 Agent（无通道则不显示按钮） */
  onSendToAgent?: (text: string) => void
}): React.JSX.Element | null {
  const [md, setMd] = useState<string | null>(null)
  const [hover, setHover] = useState<{ rel: Rel; x: number; y: number } | null>(null)
  /** 头像：avVer 版本号（上传后 +1 穿透缓存）；avFail 记录 404（未上传）的名字回退首字头像 */
  const [avVer, setAvVer] = useState(0)
  const [avFail, setAvFail] = useState<Set<string>>(new Set())
  const [avErr, setAvErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingNameRef = useRef<string | null>(null)

  useEffect(() => {
    void fetchDoc('设定/关系.md')
      .then(setMd)
      .catch(() => setMd(''))
  }, [])

  // 卡片墙上传头像后广播刷新（CardsView dispatch）
  useEffect(() => {
    const onUp = (): void => {
      setAvVer((v) => v + 1)
      setAvFail(new Set())
    }
    window.addEventListener('relnet:avatar', onUp)
    return () => window.removeEventListener('relnet:avatar', onUp)
  }, [])

  /** 节点右键 → 选择图片上传（名字含路径非法字符者不允许，如「徐大荒/猎妖队」） */
  const pickAvatar = (name: string): void => {
    if (/[\\/:*?"<>|]/.test(name)) return
    pendingNameRef.current = name
    fileRef.current?.click()
  }
  const onPickFile = async (file: File | undefined): Promise<void> => {
    const name = pendingNameRef.current
    if (!file || !name) return
    const res = await uploadAvatar(name, file)
    if (res.ok) {
      setAvErr('')
      setAvFail((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      setAvVer((v) => v + 1)
    } else {
      setAvErr(`${name}：${res.error ?? '上传失败'}`)
    }
  }
  /** 单击开卡（260ms 防抖）/ 双击放大查看头像（双击时取消单击） */
  const [zoom, setZoom] = useState<Ent | null>(null)
  const clickTimerRef = useRef(0)
  const scheduleOpen = (e: Ent): void => {
    window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = window.setTimeout(() => openEnt(e), 260)
  }
  useEffect(() => {
    if (!zoom) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  const graph = useMemo((): { ents: Ent[]; rels: Rel[] } | null => {
    if (!md) return null
    const pairs = parseRelations(md)
    if (pairs.length === 0) return null
    // 实体全集（按首次出现顺序）
    const order: string[] = []
    for (const p of pairs) {
      for (const n of [p.a, p.b]) if (!order.includes(n)) order.push(n)
    }
    // 角色文件字节 → 权重（设定/角色/ 组卡片，name 形如「角色名.md」）
    const bytesOf = new Map<string, number>()
    for (const g of section?.groups ?? []) {
      for (const c of g.cards) {
        if (!c.name.endsWith('.md')) continue
        bytesOf.set(c.name.replace(/\.md$/, ''), c.bytes ?? 0)
      }
    }
    // 头像半径：角色按文件大小 20→34px；无文件实体固定 14px
    const radiusOf = (bytes: number): number =>
      bytes > 0 ? 20 + Math.min(14, Math.round(Math.sqrt(bytes) / 40)) : 14
    // 布局：最大者居中，其余按大小降序铺两圈同心环（角色优先内圈）
    const sorted = [...order].sort((x, y) => (bytesOf.get(y) ?? 0) - (bytesOf.get(x) ?? 0))
    const center = sorted[0]!
    const ring1 = sorted.slice(1, 9)
    const ring2 = sorted.slice(9)
    const ents: Ent[] = []
    const put = (name: string, x: number, y: number): void => {
      const bytes = bytesOf.get(name) ?? 0
      ents.push({
        name,
        bytes,
        isChar: bytes > 0,
        x,
        y,
        r: radiusOf(bytes),
        color: colorOf(name),
      })
    }
    put(center, W / 2, H / 2)
    ring1.forEach((name, i) => {
      const ang = -Math.PI / 2 + (i / ring1.length) * Math.PI * 2
      put(name, W / 2 + Math.cos(ang) * 128, H / 2 + Math.sin(ang) * 96)
    })
    ring2.forEach((name, i) => {
      const ang = -Math.PI / 2 + ((i + 0.5) / ring2.length) * Math.PI * 2
      put(name, W / 2 + Math.cos(ang) * 230, H / 2 + Math.sin(ang) * 150)
    })
    // 关系线（实体 index 化）
    const idx = new Map(ents.map((e, i) => [e.name, i]))
    const rels: Rel[] = []
    for (const p of pairs) {
      const a = idx.get(p.a)
      const b = idx.get(p.b)
      if (a === undefined || b === undefined || a === b) continue
      rels.push({ a, b, label: p.label.slice(0, 26) })
    }
    return { ents, rels }
  }, [md, section])

  if (!md) return null // 关系.md 加载中
  if (!graph || graph.ents.length === 0) {
    // 数据缺失可见化：文件不存在 / 没解析出关系对
    return (
      <section className="relnet relnet-empty">
        <div className="relnet-head">
          <span className="relnet-title">
            <Icon name="users" size={13} /> 人物关系网
          </span>
        </div>
        <div className="relnet-missing">
          未找到可用关系数据——请在 <b>设定/关系.md</b> 中用表格（角色 A / 角色 B / 关系类型）或
          「<b>- A &amp; B：描述</b>」列表描述人物关系。
          {onSendToAgent && (
            <button
              type="button"
              className="relnet-build-btn"
              title="让 Agent 读取角色卡/正文，按标准表格格式补建 设定/关系.md"
              onClick={() => onSendToAgent(RELNET_BUILD_PROMPT)}
            >
              <Icon name="spark" size={12} /> 让 Agent 补建
            </button>
          )}
        </div>
      </section>
    )
  }

  const openEnt = (e: Ent): void => {
    if (!e.isChar) return // 势力/系统等无角色卡：不可点
    const card = (section?.groups ?? []).flatMap((g) => g.cards).find((c) => c.name === `${e.name}.md`)
    onOpenDoc(
      card ?? {
        path: `追踪/角色状态/${e.name}.md`,
        name: `${e.name}.md`,
        kind: 'md',
        title: e.name,
        readOnly: true,
      },
    )
  }

  return (
    <section className="relnet">
      <div className="relnet-head">
        <span className="relnet-title">
          <Icon name="users" size={13} /> 人物关系网
        </span>
        <span className="relnet-sub">
          {graph.ents.length} 实体 · {graph.rels.length} 关系 · 悬停看描述 · 点角色开设定卡 · 右键上传头像
          {avErr && <b className="relnet-err">（{avErr}）</b>}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="relnet-svg" role="img" aria-label="人物关系网">
        {/* 关系线 */}
        {graph.rels.map((r, i) => {
          const a = graph.ents[r.a]!
          const b = graph.ents[r.b]!
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={`relnet-edge${hover?.rel === r ? ' on' : ''}`}
              style={{ strokeWidth: hover?.rel === r ? 2.4 : 1 + Math.min(1.6, (a.bytes + b.bytes) / 80000) }}
              onMouseEnter={() => setHover({ rel: r, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
        {/* 实体头像节点：圈内核/图片 + 下方全名（textLength 压缩防溢出）；右键上传头像 */}
        {graph.ents.map((e, i) => {
          const src = avFail.has(e.name) ? null : avatarUrl(e.name, avVer)
          const capMax = Math.max(76, e.r * 2 + 24)
          const capFs = 11.5
          const overflow = e.name.length * capFs > capMax
          return (
            <g
              key={e.name}
              className={`relnet-node${e.isChar ? '' : ' faction'}`}
              onClick={() => scheduleOpen(e)}
              onDoubleClick={(ev) => {
                ev.stopPropagation()
                window.clearTimeout(clickTimerRef.current)
                setZoom(e)
              }}
              onContextMenu={(ev) => {
                ev.preventDefault()
                pickAvatar(e.name)
              }}
              transform={`translate(${e.x}, ${e.y})`}
            >
              <circle r={e.r + 3} className="relnet-halo" style={{ stroke: e.color }} />
              {src ? (
                <>
                  <clipPath id={`relnet-av-${i}`}>
                    <circle r={e.r} />
                  </clipPath>
                  <image
                    href={src}
                    x={-e.r}
                    y={-e.r}
                    width={e.r * 2}
                    height={e.r * 2}
                    clipPath={`url(#relnet-av-${i})`}
                    preserveAspectRatio="xMidYMid slice"
                    onError={() =>
                      setAvFail((prev) => {
                        const next = new Set(prev)
                        next.add(e.name)
                        return next
                      })
                    }
                  />
                </>
              ) : (
                <>
                  <circle r={e.r} className="relnet-dot" style={{ fill: e.isChar ? e.color : 'transparent' }} />
                  <text y={e.r * 0.32} textAnchor="middle" className="relnet-initial" style={{ fontSize: e.r * 0.95 }}>
                    {e.name[0]}
                  </text>
                </>
              )}
              {/* 全名在头像下方；过长时压缩进可用宽度（spacingAndGlyphs 保持不溢出） */}
              <text
                y={e.r + 15}
                textAnchor="middle"
                className="relnet-cap"
                style={{ fontSize: capFs }}
                textLength={overflow ? capMax : undefined}
                lengthAdjust={overflow ? 'spacingAndGlyphs' : undefined}
              >
                {e.name}
              </text>
            </g>
          )
        })}
        {/* 悬停关系描述：置于最外层（DOM 末尾 = 节点/连线之上），任意位置不被遮盖 */}
        {hover && (
          <g pointerEvents="none">
            <rect
              x={Math.max(8, Math.min(W - 140, hover.x - 66))}
              y={hover.y - 24}
              width={132}
              height={20}
              rx={10}
              className="relnet-tip-bg"
            />
            <text
              x={Math.max(74, Math.min(W - 74, hover.x))}
              y={hover.y - 10}
              textAnchor="middle"
              className="relnet-tip"
            >
              {hover.rel.label}
            </text>
          </g>
        )}
      </svg>
      {/* 头像上传选择器（右键节点触发) */}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(ev) => {
          void onPickFile(ev.target.files?.[0])
          ev.target.value = '' // 允许重复选择同一文件
        }}
      />
      {/* 双击放大查看头像（原图尺寸灯箱） */}
      {zoom && (
        <div className="relnet-zoom" onClick={() => setZoom(null)}>
          {avFail.has(zoom.name) ? (
            <div className="relnet-zoom-fallback" style={{ background: zoom.color }}>
              {zoom.name[0]}
            </div>
          ) : (
            <img src={avatarUrl(zoom.name, avVer)} alt={zoom.name} />
          )}
          <div className="relnet-zoom-name">{zoom.name}</div>
          <div className="relnet-zoom-hint">点击任意处关闭 · 右键节点可更换头像</div>
        </div>
      )}
    </section>
  )
}

/** 相对时间（资料卡 meta 用）；与 RelNet 同文件导出避免散落 */
export function docAgo(ms: number): string {
  return ago(ms)
}
