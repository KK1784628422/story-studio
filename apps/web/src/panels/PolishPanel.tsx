/**
 * 优化模式 · 章节优化选择器：
 * - 章节网格（章号/标题/大小），勾选多章 → 底部浮动操作条「优化选中 N 章」组装 prompt 移交 Agent；
 * - 单章快捷「优化」；支持全选/清空；选中态金色高亮。
 * - 必须选择倾向：精简（去AI味，保门禁+字数达标，不更新追踪）/ 升华（提质，只读细纲+本章+前章，
 *   全量改写，不跑门禁质检，审批确认后登记作者免检）。
 */
import { useState } from 'react'
import type { ChapterBrief } from '@story-studio/shared'
import { Icon } from '../components/Icon.tsx'

/** 升华支路机器标记：chat.ts 据此识别「作者批准免检」流程（与 apps/server/src/routes/chat.ts 常量保持一致） */
const ELEVATE_MARKER = '<!--polish-variant:elevate-->'

export type PolishVariant = 'simplify' | 'elevate'

/** 字节 → 可读大小 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

export function PolishPanel({
  chapters,
  onSendToAgent,
}: {
  chapters: ChapterBrief[]
  onSendToAgent: (text: string) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [sending, setSending] = useState(false)
  /** 倾向必须显式选择后才可发起优化 */
  const [variant, setVariant] = useState<PolishVariant | null>(null)

  const toggle = (idx: number): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const list = [...picked].sort((a, b) => a - b)
  const titleOf = (idx: number): string => chapters.find((c) => c.index === idx)?.title ?? ''

  /** 组装优化 prompt（按所选倾向）；未选倾向不发 */
  const sendWith = (chapters: number[]): void => {
    if (chapters.length === 0 || sending || !variant) return
    const pick = chapters.map((i) => `第 ${i} 章《${titleOf(i)}》`).join('、')
    const label = chapters.length > 1 ? `以下 ${chapters.length} 章：${pick}` : pick
    const prompt =
      variant === 'elevate'
        ? `${ELEVATE_MARKER}\n请升华优化${label}。对每章只读取三份文件：本章细纲（大纲/细纲_第NNN章.md，内含伏笔/钩子/填坑意图）、` +
          '本章正文、前一章正文。以提升文笔质感、表达高级、氛围丰盈为唯一目标，一次到位全量改写本章正文（用 Write 覆盖，' +
          '不要 Edit 分轮小改、不要动其它文件、不要跑任何质检/门禁脚本）；改写完停在审批卡等我确认，我确认后该章即视为「作者已确认」免检。'
        : `请精简优化${label}。按 story-deslop 技能流程逐章处理：先诊断分级（轻/中/重，按客观指标）` +
          '→ 在聊天里展示处理方案（含删除比例上限）等我确认 → 在 `.story-studio/tmp/` 临时稿上逐 Gate 清改并用 Bash 跑质检脚本验收（blocking 清零；不要对正文逐个 Edit 边改边触发审批）' +
          '→ 验收通过后一次 Write 全量写回正文章节（只有这一张审批卡，卡内是该章完整红删绿增 diff，我一次确认）' +
          '。定稿标准：门禁通过（blocking 清零）+ 字数达标（对照本章细纲字数目标下限，跌破则降 AI 重写补足）。完稿后不提交任何 tracking 事务、不更新追踪状态。'
    setSending(true)
    onSendToAgent(prompt)
    setPicked(new Set())
    setVariant(null)
    setSending(false)
  }

  const send = (): void => sendWith(list)

  return (
    <div className="pl-panel">
      <div className="pl-head">
        <span className="pl-badge">
          <Icon name="spark" size={13} /> 优化工作台
        </span>
        <span className="pl-sub">勾选章节 → 选择倾向 → 交给 Agent 处理（改写前会先给方案与 diff 确认）</span>
        <div className="pl-variants" role="radiogroup" aria-label="优化倾向">
          <button
            type="button"
            role="radio"
            aria-checked={variant === 'simplify'}
            className={`pl-variant${variant === 'simplify' ? ' on' : ''}`}
            onClick={() => setVariant('simplify')}
          >
            <Icon name="spark" size={12} /> 精简
            <span className="pl-variant-desc">去AI味 · 保门禁 · 字数达标</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={variant === 'elevate'}
            className={`pl-variant${variant === 'elevate' ? ' on' : ''}`}
            onClick={() => setVariant('elevate')}
          >
            <Icon name="palette" size={12} /> 升华
            <span className="pl-variant-desc">提质 · 免门禁 · 作者确认免检</span>
          </button>
        </div>
      </div>

      {chapters.length === 0 ? (
        <div className="pl-empty">还没有章节可优化。</div>
      ) : (
        <div className="pl-grid">
          {chapters.map((c) => {
            const on = picked.has(c.index)
            return (
              <div
                key={c.index}
                className={`pl-card${on ? ' on' : ''}`}
                role="checkbox"
                aria-checked={on}
                tabIndex={0}
                onClick={() => toggle(c.index)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault()
                    toggle(c.index)
                  }
                }}
              >
                <span className={`pl-check${on ? ' on' : ''}`} aria-hidden>
                  {on ? '✓' : ''}
                </span>
                <span className="pl-card-no">第 {c.index} 章</span>
                <span className="pl-card-title">{c.title}</span>
                <span className="pl-card-meta">{fmtSize(c.bytes)}</span>
                <button
                  type="button"
                  className="pl-quick"
                  disabled={!variant}
                  title={variant ? `按「${variant === 'elevate' ? '升华' : '精简'}」仅优化第 ${c.index} 章` : '请先在上方选择优化倾向'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (variant) sendWith([c.index])
                  }}
                >
                  优化
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* 底部浮动操作条 */}
      {picked.size > 0 && (
        <div className="pl-bar">
          <span className="pl-bar-text">
            已选 <b>{picked.size}</b> 章{list.length > 0 ? `（第 ${list[0]}${list.length > 1 ? ` ~ ${list[list.length - 1]}` : ''} 章）` : ''}
          </span>
          <button type="button" className="pl-bar-clear" onClick={() => setPicked(new Set())}>
            清空
          </button>
          <button
            type="button"
            className="pl-bar-go"
            onClick={send}
            disabled={sending || !variant}
            title={variant ? '' : '请先在上方选择优化倾向'}
          >
            <Icon name="spark" size={12} /> {variant ? `按「${variant === 'elevate' ? '升华' : '精简'}」优化` : '先选倾向'}
          </button>
        </div>
      )}
    </div>
  )
}
