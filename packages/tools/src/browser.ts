/**
 * browser_cdp 工具（M4）：CDP 控制 Chrome（复用登录态），扫榜/市场调研用。
 * 方案沿用 oh-story browser-cdp 技能：agent-browser CLI + setup-cdp-chrome.js。
 * - execFile 直调 agent-browser 的 js 入口（绕过 Windows .cmd shim 的 CVE-2024-27980 问题，
 *   与 oh-story cdp-utils.js 的 resolveWindowsAgentBrowser 同思路，此处路径已知无需解析）
 * - eval 一律走 base64 通道（-b），避免命令行参数在 Windows 上的二次解析
 * - setup 动作会 kill 用户常规 Chrome（skill 铁律：必须先征得用户同意）
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface BrowserExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

const DEFAULT_PORT = 9222
const AB_TIMEOUT = 25_000

/**
 * 桌面化内置浏览器 CDP 端口（Electron 主进程写入 <repo>/.local/embedded-cdp-port）。
 * 桌面模式下扫榜/浏览器操作走内置 BrowserView，绝不动系统浏览器；非桌面模式返回 null 回退 9222。
 * 注意：server 的 cwd 随启动方式不同（pnpm --filter=apps/server；桌面 fork=仓库根），
 * 故从 cwd 向上逐级找 .local/embedded-cdp-port，兼容两种布局。
 */
function readEmbeddedCdpPort(): number | null {
  try {
    let dir = process.cwd()
    for (let i = 0; i < 5; i++) {
      const file = resolve(dir, '.local', 'embedded-cdp-port')
      if (existsSync(file)) {
        const port = Number(readFileSync(file, 'utf8').trim())
        return Number.isInteger(port) && port > 0 ? port : null
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  } catch {
    return null
  }
}

function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal | null): Promise<BrowserExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal: signal ?? undefined },
      (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: number | string }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolve({ ok: !err, exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') })
      },
    )
  })
}

/**
 * win32 直接 exec agent-browser 原生二进制：node 包装器（bin/agent-browser.js）内部 spawn 原生
 * exe 时固定 windowsHide:false——桌面应用无控制台环境下每次调用都会弹黑色 cmd 窗口。
 * 绕开包装器直接 exec 原生 exe（调用侧 run() 已带 windowsHide:true）。POSIX 无控制台窗口概念，仍走包装器。
 */
function nativeAgentBrowserPath(abJs: string): string | null {
  if (process.platform !== 'win32') return null
  const p = join(dirname(abJs), `agent-browser-${process.platform}-${process.arch}.exe`)
  return existsSync(p) ? p : null
}

export interface BrowserCdpDeps {
  /** agent-browser 的 js 入口（node_modules/agent-browser/bin/agent-browser.js） */
  agentBrowserJs: string
  /** vendor 技能根（找 browser-cdp/scripts/setup-cdp-chrome.js） */
  skillsRoot: string
  port?: number
  /** 当前请求级中止信号提供者（用户停止 Agent → abort → 终止在跑的浏览器操作） */
  currentSignal?: () => AbortSignal | null
}

export class BrowserCdpClient {
  private readonly abJs: string
  private readonly setupScript: string
  private readonly explicitPort?: number
  private readonly currentSignal?: () => AbortSignal | null

  constructor(deps: BrowserCdpDeps) {
    this.explicitPort = deps.port
    this.abJs = deps.agentBrowserJs
    this.setupScript = join(deps.skillsRoot, 'browser-cdp', 'scripts', 'setup-cdp-chrome.js')
    this.currentSignal = deps.currentSignal
  }

  /** 实际 CDP 端口：桌面模式 = 内置浏览器端口；否则 = 显式配置 / 9222（独立调试 Chrome） */
  get port(): number {
    return readEmbeddedCdpPort() ?? this.explicitPort ?? DEFAULT_PORT
  }

  /** 是否桌面内置浏览器模式（内置 BrowserView，无需 setup 外部 Chrome） */
  get isEmbedded(): boolean {
    return readEmbeddedCdpPort() !== null
  }

  get available(): boolean {
    return existsSync(this.abJs)
  }

  get setupScriptExists(): boolean {
    return existsSync(this.setupScript)
  }

  /** agent-browser CLI 调用（--cdp port 已自动前置；win32 直调原生二进制，避免包装器黑框弹窗） */
  async ab(args: string[], timeoutMs = AB_TIMEOUT): Promise<BrowserExecResult> {
    if (!this.available) {
      return { ok: false, exitCode: -1, stdout: '', stderr: `agent-browser 未安装：${this.abJs} 不存在（pnpm add -w -D agent-browser）` }
    }
    const signal = this.currentSignal?.() ?? null
    const native = nativeAgentBrowserPath(this.abJs)
    if (native) {
      return run(native, ['--cdp', String(this.port), ...args.map(String)], timeoutMs, signal)
    }
    return run(process.execPath, [this.abJs, '--cdp', String(this.port), ...args.map(String)], timeoutMs, signal)
  }

  /** 探测 CDP 状态（无副作用）。桌面模式直接探内置浏览器端口；非桌面走 setup-cdp-chrome.js --detect-only */
  async detect(): Promise<{
    cdpStatus: 'ready' | 'needs-setup' | 'unknown'
    browser?: string
    chromeRunning?: boolean
    chromePidCount?: number
    raw: string
  }> {
    if (this.isEmbedded) {
      // 桌面模式：内置浏览器由主进程随应用启动，CDP 端口在线即 ready（绝不需要 setup 外部 Chrome）
      const r = await this.ab(['tab', 'list', '--json'], 8_000)
      if (r.ok) return { cdpStatus: 'ready', browser: 'embedded', raw: `内置浏览器 CDP :${this.port} 在线` }
      return { cdpStatus: 'needs-setup', raw: `内置浏览器 CDP :${this.port} 无响应——请在桌面应用打开「Agent浏览器」面板` }
    }
    if (!this.setupScriptExists) {
      return { cdpStatus: 'unknown', raw: `setup 脚本不存在：${this.setupScript}` }
    }
    const r = await run(process.execPath, [this.setupScript, String(this.port), '--detect-only'], 20_000)
    const raw = `${r.stdout}\n${r.stderr}`.trim()
    const status = /^CDP_STATUS=(\S+)/m.exec(raw)?.[1]
    return {
      cdpStatus: status === 'ready' || status === 'needs-setup' ? status : 'unknown',
      browser: /^BROWSER=(.+)$/m.exec(raw)?.[1],
      chromeRunning: /^CHROME_RUNNING=(\w+)/m.exec(raw)?.[1] === 'yes' ? true : undefined,
      chromePidCount: Number(/^CHROME_PID_COUNT=(\d+)/m.exec(raw)?.[1] ?? '') || undefined,
      raw,
    }
  }

  /** 启动 debug Chrome（--yes = 已征得用户同意；会 kill 常规浏览器）。
   *  桌面模式不启动外部 Chrome——内置浏览器随应用已启动，直接返回就绪。 */
  async setup(kind?: string): Promise<BrowserExecResult> {
    if (this.isEmbedded) {
      return { ok: true, exitCode: 0, stdout: `桌面模式：内置浏览器随应用已启动（CDP :${this.port}），无需 setup 外部 Chrome`, stderr: '' }
    }
    if (!this.setupScriptExists) {
      return { ok: false, exitCode: -1, stdout: '', stderr: `setup 脚本不存在：${this.setupScript}` }
    }
    if (kind) process.env.STORY_BROWSER_KIND = kind
    return run(process.execPath, [this.setupScript, String(this.port), '--yes'], 60_000)
  }

  /** 浏览器内执行 JS（base64 通道），尽力解析 JSON 返回 */
  async eval(js: string): Promise<{ ok: boolean; exitCode: number; result?: unknown; raw: string; stderr: string }> {
    const encoded = Buffer.from(js, 'utf8').toString('base64')
    const r = await this.ab(['eval', '-b', encoded])
    let result: unknown
    if (r.ok && r.stdout && r.stdout !== 'ERR') {
      try {
        result = JSON.parse(r.stdout)
        if (typeof result === 'string') {
          try {
            result = JSON.parse(result)
          } catch {
            /* 保留字符串 */
          }
        }
      } catch {
        result = undefined
      }
    }
    return { ok: r.ok, exitCode: r.exitCode, result, raw: r.stdout, stderr: r.stderr }
  }

  /**
   * 桌面模式：把 daemon 活动 tab 切到「内置浏览器」target（非回环 URL 的 page target），
   * 防止 agent 误操作主窗口（story-studio UI，恒为 127.0.0.1）。非桌面模式为空操作。
   * 找不到内置 target 时返回失败（宁可不操作也不碰 UI）。
   */
  async lockEmbeddedTab(): Promise<{ ok: boolean; error?: string; targetId?: string }> {
    if (!this.isEmbedded) return { ok: true }
    const r = await this.ab(['tab', 'list', '--json'], 8_000)
    if (!r.ok) return { ok: false, error: `无法列出内置浏览器 target（CDP :${this.port}）：${r.stderr.slice(0, 200)}` }
    try {
      const parsed = JSON.parse(r.stdout) as { data?: { tabs?: Array<{ type?: string; url?: string; targetId?: string }> } }
      const tabs = parsed?.data?.tabs ?? []
      const isLoopback = (u?: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?\//i.test(u ?? '')
      const embedded = tabs.find((t) => t && t.type === 'page' && !isLoopback(t.url))
      if (!embedded?.targetId) {
        return { ok: false, error: `未找到内置浏览器 target（CDP :${this.port} 只有回环/无 page target）——请在桌面应用打开「内置浏览器」面板` }
      }
      const sw = await this.ab(['tab', embedded.targetId], 8_000)
      return sw.ok ? { ok: true, targetId: embedded.targetId } : { ok: false, error: sw.stderr.slice(0, 200) }
    } catch (e) {
      return { ok: false, error: `解析 target 清单失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
