/** 本机浏览器探测：给「浏览器偏好配置」提供候选（Chrome/Edge/Firefox/Brave）。
 *  探测路径对齐 setup-cdp-chrome.js 的 chromePaths 思路（Windows 为主 + macOS/Linux 兜底）。 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type BrowserId = 'chrome' | 'edge' | 'firefox' | 'brave' | 'safari'

export interface BrowserProbeItem {
  id: BrowserId
  label: string
  found: boolean
  /** 可执行文件路径（未发现为空） */
  path?: string
}

/** 从 HTTP User-Agent 识别用户正在使用的浏览器（用户用哪个浏览器打开 Story Studio，就用哪个做扩展注入） */
export function detectBrowserFromUA(ua?: string | null): BrowserId | null {
  const s = ua ?? ''
  if (!s) return null
  if (/Edg\//.test(s)) return 'edge'
  if (/Firefox\//.test(s) && !/Seamonkey/.test(s)) return 'firefox'
  if (/Chrome\//.test(s) && !/Edg\//.test(s)) return 'chrome' // 含 Brave（UA 与 Chrome 同形）
  if (/Safari\//.test(s) && !/Chrome\//.test(s)) return 'safari'
  return null
}

function check(paths: string[]): string | undefined {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

export function probeBrowsers(): BrowserProbeItem[] {
  const pf = process.env.PROGRAMFILES ?? ''
  const pfx = process.env['PROGRAMFILES(X86)'] ?? ''
  const la = process.env.LOCALAPPDATA ?? ''
  const defs: Array<{ id: BrowserId; label: string; paths: string[] }> = [
    {
      id: 'chrome',
      label: 'Chrome',
      paths: [
        join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
      ],
    },
    {
      id: 'edge',
      label: 'Edge',
      paths: [
        join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        '/usr/bin/microsoft-edge',
      ],
    },
    {
      id: 'firefox',
      label: 'Firefox',
      paths: [
        join(pf, 'Mozilla Firefox', 'firefox.exe'),
        join(la, 'Mozilla Firefox', 'firefox.exe'),
        '/Applications/Firefox.app/Contents/MacOS/firefox',
        '/usr/bin/firefox',
      ],
    },
    {
      id: 'brave',
      label: 'Brave',
      paths: [
        join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ],
    },
  ]
  return defs.map((d) => {
    const p = check(d.paths)
    return { id: d.id, label: d.label, found: !!p, path: p }
  })
}
