/**
 * web_search 工具（M3）：Bing HTML 抓取为主通道 + DuckDuckGo 降级（均无 key、尽力而为）。
 * 供讨论模式查资料 / 市场模式辅助。反爬或网络失败时返回结构化 error，模型可告知用户。
 * 实测：本机网络 DDG 连接超时（被墙），Bing 可达 → Bing 优先。
 */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

/* ---------- Bing（主通道） ---------- */

export function parseBingHtml(html: string, max = 8): SearchHit[] {
  const hits: SearchHit[] = []
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const m = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!m) continue
    const url = decodeEntities(m[1])
    const title = stripTags(m[2])
    if (!title || !/^https?:\/\//.test(url)) continue
    const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = pm ? stripTags(pm[1]) : ''
    if (hits.some((h) => h.url === url)) continue
    hits.push({ title, url, snippet })
    if (hits.length >= max) break
  }
  return hits
}

export async function bingSearch(query: string, timeoutMs = 10000): Promise<SearchHit[]> {
  const html = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=10`,
    { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } },
    timeoutMs,
  )
  return parseBingHtml(html)
}

/* ---------- DuckDuckGo（降级通道） ---------- */

/** DDG 的跳转链接形如 //duckduckgo.com/l/?uddg=<urlencode>&rut=…，还原真实 URL */
function unwrapDdgHref(href: string): string {
  if (href.startsWith('//')) href = `https:${href}`
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    if (uddg) return uddg
    return u.toString()
  } catch {
    return href
  }
}

export function parseDdgHtml(html: string, max = 8): SearchHit[] {
  const hits: SearchHit[] = []
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g
  for (const m of html.matchAll(re)) {
    const url = unwrapDdgHref(decodeEntities(m[1]))
    const title = stripTags(m[2])
    const snippet = m[3] ? stripTags(m[3]) : ''
    if (!title || !url || url.includes('duckduckgo.com/y.js')) continue
    if (hits.some((h) => h.url === url)) continue
    hits.push({ title, url, snippet })
    if (hits.length >= max) break
  }
  return hits
}

export async function duckDuckGoSearch(query: string, timeoutMs = 10000): Promise<SearchHit[]> {
  const html = await fetchText(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        accept: 'text/html',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      body: new URLSearchParams({ q: query, kl: 'cn-zh' }).toString(),
    },
    timeoutMs,
  )
  return parseDdgHtml(html)
}

/* ---------- 汇聚：Bing → DDG ---------- */

export async function webSearch(query: string): Promise<{ hits: SearchHit[]; engine: string; errors: string[] }> {
  const errors: string[] = []
  try {
    const hits = await bingSearch(query)
    if (hits.length > 0) return { hits, engine: 'bing', errors }
    errors.push('bing: 0 results')
  } catch (err) {
    errors.push(`bing: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const hits = await duckDuckGoSearch(query)
    if (hits.length > 0) return { hits, engine: 'duckduckgo', errors }
    errors.push('duckduckgo: 0 results')
  } catch (err) {
    errors.push(`duckduckgo: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { hits: [], engine: 'none', errors }
}
