/** 工具调用事件卡片：useChat 数据流里的每个 tool part 渲染为可折叠卡片（彩色瓷片图标 = 工具专属色） */
import { useState } from 'react'
import { Icon } from '../components/Icon.tsx'
import { metaOf } from './toolMeta.ts'

export interface ToolPartLike {
  type: string
  toolCallId: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'approval-requested' | 'approval-responded'
  input?: unknown
  output?: unknown
  error?: unknown
  approval?: { id: string; approved?: boolean; reason?: string; isAutomatic?: boolean }
}

type BadgeTone = 'ok' | 'bad' | ''
interface BadgeInfo {
  icon?: string
  text: string
  tone: BadgeTone
}

function gateBadge(output: Record<string, unknown> | undefined): BadgeInfo | null {
  const gate = output?.gate as { passed?: boolean; attempts?: number; stopped?: boolean } | null | undefined
  if (!gate) return null
  if (gate.passed) return { icon: 'check-circle', text: 'GATE PASSED', tone: 'ok' }
  return { icon: 'x-circle', text: `GATE FAILED ×${gate.attempts ?? '?'}${gate.stopped ? '（已转人工）' : ''}`, tone: 'bad' }
}

function bashBadge(output: Record<string, unknown> | undefined): BadgeInfo | null {
  if (!output || typeof output.exitCode !== 'number') return null
  return output.exitCode === 0
    ? { text: 'exit 0', tone: '' }
    : { icon: 'warning', text: `exit ${output.exitCode}`, tone: 'bad' }
}

/** 工具卡的徽标（时间线行与卡片共用） */
export function toolBadge(part: ToolPartLike): BadgeInfo {
  const output = part.output as Record<string, unknown> | undefined
  return part.state === 'output-error'
    ? { icon: 'x-circle', text: '出错', tone: 'bad' }
    : part.state === 'output-available'
      ? (gateBadge(output) ?? bashBadge(output) ?? { text: '', tone: '' })
      : part.state === 'input-available'
        ? { icon: 'hourglass', text: '执行中', tone: '' }
        : { text: '…', tone: '' }
}

export function ToolCard({ part }: { part: ToolPartLike }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const name = part.type.replace(/^tool-/, '')
  const meta = metaOf(name)
  const input = (part.input ?? {}) as Record<string, unknown>
  const output = part.output as Record<string, unknown> | undefined
  const badge = toolBadge(part)

  return (
    <div className={`tool-card ${badge.tone === 'bad' ? 'tool-card-failed' : ''}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon" style={{ color: meta.color }}>
          <Icon name={meta.icon} size={15} />
        </span>
        <span className="tool-name">{meta.label}</span>
        <span className="tool-summary">{meta.summarize(input)}</span>
        {badge.text && (
          <span className={`tool-badge ${badge.tone === 'ok' ? 'badge-ok' : badge.tone === 'bad' ? 'badge-bad' : ''}`}>
            {badge.icon && <Icon name={badge.icon} size={13} />} {badge.text}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-card-body">
          <div className="tool-section">输入</div>
          <pre>{JSON.stringify(part.input, null, 2)}</pre>
          {part.state === 'output-available' && (
            <>
              <div className="tool-section">输出</div>
              <pre>{formatOutput(output)}</pre>
            </>
          )}
          {part.state === 'output-error' && (
            <>
              <div className="tool-section">错误</div>
              <pre>{String(part.error ?? '')}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function formatOutput(output: unknown): string {
  if (output === undefined || output === null) return String(output)
  if (typeof output === 'string') return output
  const obj = output as Record<string, unknown>
  // 门禁 detail 单列展示，方便阅读
  const gate = obj.gate as { detail?: string } | null | undefined
  if (gate?.detail) {
    return JSON.stringify({ ...obj, gate: '⬇ 见下方门禁报告' }, null, 2) + '\n── 门禁报告 ──\n' + gate.detail
  }
  return JSON.stringify(output, null, 2)
}
