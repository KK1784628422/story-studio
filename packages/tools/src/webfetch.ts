/**
 * web_fetch 工具（M4）：匿名 HTTP 抓取 URL → HTML 净化为可读文本。
 * 结果形态借鉴 dsh WebFetchResult：{ url, statusCode, body: {kind, content}, truncated }
 * —— 非 2xx 是结果不是错误；只有「无法安全取回」才抛错。
 */

const MAX_BYTES = 200_000
const DEFAULT_TIMEOUT = 12_000

export interface WebFetchResult {
  url: string
  statusCode: number
  body: { kind: 'html' | 'text'; content: string }
  truncated: boolean
}

function decodeEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&nbsp;', ' ')
}

/** HTML → 可读文本：去脚本样式、块级标签转换行、剥标签、压缩空白 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // 整块移除（非正文噪音）
      .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // 块级/换行标签 → 换行
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      // 剥其余标签
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function webFetch(url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<WebFetchResult> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http/https：${url}`)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    const contentType = r.headers.get('content-type') ?? ''
    const raw = await r.text()
    const isHtml = /html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(raw)
    let content = isHtml ? htmlToText(raw) : raw
    let truncated = false
    if (content.length > MAX_BYTES) {
      content = content.slice(0, MAX_BYTES)
      truncated = true
    }
    return {
      url: r.url || url,
      statusCode: r.status,
      body: { kind: isHtml ? 'html' : 'text', content },
      truncated,
    }
  } finally {
    clearTimeout(timer)
  }
}
