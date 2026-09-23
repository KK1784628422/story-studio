/** Markdown 编辑工具（novel-reader 原版移植）：行内包裹 / 行首前缀，返回新文本 + 选区恢复 */

export interface MdEditResult {
  text: string
  start: number
  end: number
}

/** 用 before/after 包裹选区（无选区时插入占位文字并选中） */
export function wrapMd(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  before: string,
  after = before,
  placeholder = '文本',
): MdEditResult {
  const s = selectionStart ?? 0
  const e = selectionEnd ?? 0
  const sel = value.slice(s, e) || placeholder
  const text = value.slice(0, s) + before + sel + after + value.slice(e)
  return { text, start: s + before.length, end: s + before.length + sel.length }
}

/** 给选区所在的所有行加/去前缀（toggle） */
export function prefixMd(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  p: string,
): MdEditResult {
  const s = selectionStart ?? 0
  const e = selectionEnd ?? 0
  const segStart = value.slice(0, s).lastIndexOf('\n') + 1
  const nl = value.indexOf('\n', e)
  const segEnd = nl === -1 ? value.length : nl + 1
  const block = value.slice(segStart, segEnd)
  const nextBlock = block
    .split('\n')
    .map((l) => (l.startsWith(p) ? l.slice(p.length) : p + l))
    .join('\n')
  const text = value.slice(0, segStart) + nextBlock + value.slice(segEnd)
  return { text, start: segStart, end: segStart + nextBlock.length }
}
