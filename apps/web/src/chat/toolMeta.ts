/**
 * 工具元数据单一事实源（ToolCard / ToolCallsBar / ExecutionCanvas 共用）：
 * - icon：assets/icons/<name>.svg 图标名（单色，随 currentColor）
 * - label：展示名
 * - color：工具专属色（瓷片底/连线色，一工具一色；画布与任务栏图标语义一致）
 * - summarize：从 input 提取一行参数摘要
 * 新增工具只需在此加一行，卡片/任务栏/画布自动同步。
 */
export interface ToolMeta {
  icon: string
  label: string
  color: string
  summarize: (input: Record<string, unknown>) => string
}

export const TOOL_META: Record<string, ToolMeta> = {
  Read: { icon: 'file-text', label: 'Read', color: '#2dd4bf', summarize: (i) => String(i.path ?? '') },
  Write: { icon: 'file-pen', label: 'Write', color: '#f472b6', summarize: (i) => String(i.path ?? '') },
  Edit: { icon: 'wrench', label: 'Edit', color: '#fb7185', summarize: (i) => String(i.path ?? '') },
  Glob: { icon: 'folder-tree', label: 'Glob', color: '#38bdf8', summarize: (i) => String(i.pattern ?? '') },
  Grep: { icon: 'search', label: 'Grep', color: '#22d3ee', summarize: (i) => String(i.pattern ?? '') },
  ListFiles: { icon: 'folder', label: 'ListFiles', color: '#60a5fa', summarize: (i) => String(i.path ?? '.') },
  Bash: { icon: 'terminal', label: 'Bash', color: '#fbbf24', summarize: (i) => String(i.command ?? '') },
  tracking: { icon: 'dna', label: 'tracking', color: '#a78bfa', summarize: (i) => `mode=${String(i.mode ?? '?')}${i.entry ? ` entry=${String(i.entry)}` : ''}` },
  query_tracking: { icon: 'chart-bar', label: 'query_tracking', color: '#c084fc', summarize: (i) => `what=${String(i.what ?? '?')}` },
  load_skill: { icon: 'target', label: 'load_skill', color: '#34d399', summarize: (i) => String(i.name ?? '') },
  switch_mode: { icon: 'shuffle', label: 'switch_mode', color: '#2dd4bf', summarize: (i) => String(i.mode ?? '') },
  tts_preview: { icon: 'volume', label: 'tts_preview', color: '#f0abfc', summarize: () => '听感预览' },
  web_search: { icon: 'globe', label: 'web_search', color: '#818cf8', summarize: (i) => String(i.query ?? '') },
  web_fetch: { icon: 'file-fetch', label: 'web_fetch', color: '#5eead4', summarize: (i) => String(i.url ?? '') },
  browser_cdp: { icon: 'monitor', label: 'browser_cdp', color: '#60a5fa', summarize: (i) => String(i.action ?? '') },
  review_agents: { icon: 'eye-scan', label: 'review_agents', color: '#f59e0b', summarize: (i) => (Array.isArray(i.perspectives) ? `${(i.perspectives as string[]).length} 视角并行` : '4 视角并行') },
  save_report: { icon: 'chart-bar', label: 'save_report', color: '#a3e635', summarize: (i) => String(i.title ?? '') },
  ask_questions: { icon: 'clipboard-list', label: 'ask_questions', color: '#fb923c', summarize: (i) => (Array.isArray(i.questions) ? `向用户提出 ${(i.questions as string[]).length} 个问题` : String(i.title ?? '')) },
  ask_ai: { icon: 'monitor', label: 'ask_ai', color: '#fbbf24', summarize: () => '网页 AI 生成' },
}

/** 未登记工具的兜底元数据（灰底 + spark 图标 + 原名） */
export function metaOf(name: string): ToolMeta {
  return TOOL_META[name] ?? { icon: 'spark', label: name, color: '#94a3b8', summarize: () => '' }
}

/** 工具 part 一行摘要（工具名 · 参数摘要）：执行指示器「当前动作」/ 任务栏描述用 */
export function summarizeToolPart(part: { type: string; input?: unknown }): string {
  const name = part.type.replace(/^tool-/, '')
  const meta = TOOL_META[name]
  if (!meta) return name
  const s = meta.summarize((part.input ?? {}) as Record<string, unknown>)
  return s ? `${name} · ${s}` : name
}
