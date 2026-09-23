/**
 * 分页引擎（novel-reader 原版移植）：把章节 markdown 切成固定「每行字数 × 每页行数」的页。
 * 长段落自动断行；标题居中；段落首行缩进两个全角空格。
 * 含 TTS 逐句高亮所需的句子区间（基于行文本拼接串，与渲染严格一致）。
 */

export interface PageLine {
  text: string
  /** true = 居中显示（章节标题行） */
  center: boolean
  /** true = 本行是当前段落的起始行 */
  paraStart?: boolean
}

export interface SentenceSpan {
  /** 在本页「行文本拼接串」中的起始字符偏移（含缩进） */
  start: number
  end: number
  text: string
}

export interface PagedChapter {
  title: string
  pages: PageLine[][]
  /** 每页的纯文本（去缩进/去标记），供 TTS 使用 */
  pageTexts: string[]
  /** 每页的句子区间（基于行文本拼接串，供逐句高亮） */
  pageSentences: SentenceSpan[][]
}

export interface PaginateOptions {
  charsPerLine: number
  linesPerPage: number
}

export const DEFAULT_OPTIONS: PaginateOptions = { charsPerLine: 18, linesPerPage: 15 }

function cleanInline(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .trim()
}

/** 按句末标点切分句子（逗号不切，避免高亮闪动过密） */
const SENTENCE_SPLIT = /[^。！？!?…\n]+[。！？!?…]?/g

/** 避头尾字符集：闭标点不落行首、开标点不挂行尾（番茄/传统中文排版规则） */
const CLOSING_PUNCT = '，。！？；：、…—）》〉」』”’,.!?:;)]}%'
const OPENING_PUNCT = '（《〈「『“‘([{‘“'

/**
 * 避头尾断行：把文本切成若干不超过 limit 字的行。
 * 行尾若挂开标点则回退；断点处下一字符若为闭标点则连同当前行末字符一起下移（行长 ≤ limit，绝不溢出）。
 */
function breakText(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    while (cut > 1 && OPENING_PUNCT.includes(rest[cut - 1]!)) cut--
    if (cut < rest.length && CLOSING_PUNCT.includes(rest[cut]!)) {
      cut--
      while (cut > 1 && OPENING_PUNCT.includes(rest[cut - 1]!)) cut--
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) out.push(rest)
  return out
}

export function paginate(markdown: string, opts: PaginateOptions = DEFAULT_OPTIONS): PagedChapter {
  const charsPerLine = Math.max(10, opts.charsPerLine)
  const linesPerPage = Math.max(8, opts.linesPerPage)

  const rawParas = markdown
    .split(/\r?\n/)
    .map((line) => cleanInline(line))
    .filter((line) => line.length > 0 && !/^(-{3,}|_{3,}|\*{3,})$/.test(line))

  let title = ''
  const lines: PageLine[] = []

  for (const para of rawParas) {
    if (!title && /^#\s+/.test(para)) {
      title = para.replace(/^#\s+/, '')
      pushTitle(lines, title, charsPerLine)
      continue
    }
    const isHeading = /^#{1,6}\s+/.test(para)
    if (isHeading) {
      pushTitle(lines, para.replace(/^#{1,6}\s+/, ''), charsPerLine)
      continue
    }
    // 首行缩进：两个全角空格计入行文本（渲染层不再做 text-indent，避免双重缩进溢出裁字）
    const text = '　　' + para
    const parts = breakText(text, charsPerLine)
    parts.forEach((t, k) => {
      lines.push({ text: t, center: false, paraStart: k === 0 })
    })
  }

  const pages: PageLine[][] = []
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage))
  }
  if (pages.length === 0) pages.push([{ text: '（本章暂无内容）', center: true }])

  const pageTexts = pages.map((page) =>
    page.map((line) => line.text).join('').replace(/　/g, '').trim(),
  )

  const pageJoined = pages.map((page) => page.map((line) => line.text).join(''))
  const pageSentences = pageJoined.map((joined) => {
    const spans: SentenceSpan[] = []
    for (const m of joined.matchAll(SENTENCE_SPLIT)) {
      spans.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] })
    }
    if (spans.length === 0 && joined.length > 0) {
      spans.push({ start: 0, end: joined.length, text: joined })
    }
    return spans
  })

  return { title, pages, pageTexts, pageSentences }
}

function pushTitle(lines: PageLine[], text: string, charsPerLine: number) {
  const parts = breakText(text, charsPerLine)
  parts.forEach((t, k) => {
    lines.push({ text: t, center: true, paraStart: k === 0 })
  })
}

/** 把行文本按句子区间切为片段，标记哪个片段属于当前高亮句 */
export function splitLineBySentences(
  lineText: string,
  lineStart: number,
  sentences: SentenceSpan[],
  activeIndex: number,
): { text: string; active: boolean }[] {
  const parts: { text: string; active: boolean }[] = []
  let cur = 0
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si]
    if (s.end <= lineStart || s.start >= lineStart + lineText.length) continue
    const segStart = Math.max(s.start, lineStart)
    const segEnd = Math.min(s.end, lineStart + lineText.length)
    if (segStart > lineStart + cur) {
      parts.push({ text: lineText.slice(cur, segStart - lineStart), active: false })
    }
    parts.push({
      text: lineText.slice(segStart - lineStart, segEnd - lineStart),
      active: si === activeIndex,
    })
    cur = segEnd - lineStart
  }
  if (cur < lineText.length) {
    parts.push({ text: lineText.slice(cur), active: false })
  }
  return parts
}
