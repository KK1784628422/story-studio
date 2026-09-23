/**
 * Bash 白名单执行器：仅允许 node/python/py -3 前缀且脚本必须落在技能 scripts/ 内。
 * 不做通用 shell——白名单既安全又免去命令注入面。
 * 支持 oh-story 技能命令形态：node scripts/check-ai-patterns.js 正文/第NNN章_*.md
 *   （cwd=书工作区；scripts/ 前缀自动解析到技能目录；glob 参数自动展开）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import fg from 'fast-glob'
import type { SkillLoader } from '@story-studio/skills'
import { resolveSandboxPath, SandboxError, type SandboxRoots } from './sandbox.ts'

/** 桌面应用是否在线（内置浏览器 CDP 端口文件由 Electron 主进程写入）。进程 cwd = 仓库根。 */
function isEmbeddedBrowserActive(): boolean {
  try {
    return existsSync(resolve(process.cwd(), '.local', 'embedded-cdp-port'))
  } catch {
    return false
  }
}

export interface RunResult {
  command: string
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
  /** 因用户停止 Agent / 客户端断开而被强制终止（exitCode=130） */
  aborted?: boolean
}

export interface BashExecutorOptions {
  workspace: string
  sandbox: SandboxRoots
  skills: SkillLoader
  /** python 解释器（'python' | 'py -3'），自动探测 */
  pythonCommand?: string
  /** 当前请求级中止信号提供者（server 每轮请求注入；执行时读取最新值，abort 即树杀子进程） */
  currentSignal?: () => AbortSignal | null
}

const MAX_OUTPUT = 12_000

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  const head = s.slice(0, MAX_OUTPUT * 2 / 3)
  const tail = s.slice(-MAX_OUTPUT / 3)
  return `${head}\n...（输出过长，中间省略 ${s.length - MAX_OUTPUT} 字符）...\n${tail}`
}

/** 简易分词：支持双引号/单引号包裹 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) tokens.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
    }
  }
  if (cur || has) tokens.push(cur)
  return tokens
}

const PYTHON_CANDIDATES = [
  { cmd: 'python', args: [] as string[] },
  { cmd: 'py', args: ['-3'] },
]

let detectedPython: { cmd: string; args: string[] } | null = null

/** 探测可用的 Python 3 解释器（结果缓存） */
export async function detectPython(): Promise<{ cmd: string; args: string[] }> {
  if (detectedPython) return detectedPython
  for (const cand of PYTHON_CANDIDATES) {
    try {
      const r = await runProcess(cand.cmd, [...cand.args, '--version'], process.cwd(), 10_000)
      if (r.exitCode === 0 && /Python 3\./.test(r.stdout + r.stderr)) {
        detectedPython = cand
        return cand
      }
    } catch {
      // 继续尝试下一个
    }
  }
  throw new Error('未找到 Python 3 解释器（尝试过 python / py -3）。tracking 与 storyctl 脚本需要 Python 3.10+。')
}

export class BashExecutor {
  /** 最近加载技能目录 provider（运行期由 ToolContext 注入，供脚本解析优先级） */
  preferredSkillDirs?: () => string[]

  constructor(private opts: BashExecutorOptions) {}

  get python(): Promise<{ cmd: string; args: string[] }> {
    return this.opts.pythonCommand
      ? Promise.resolve(
          this.opts.pythonCommand.includes(' ')
            ? { cmd: this.opts.pythonCommand.split(' ')[0]!, args: this.opts.pythonCommand.split(' ').slice(1) }
            : { cmd: this.opts.pythonCommand, args: [] },
        )
      : detectPython()
  }

  /** 沙箱内的裸进程执行（供门禁/追踪直接调用；未显式传 signal 时自动取当前请求中止信号） */
  async runProcessRaw(
    cmd: string,
    args: string[],
    cwd: string,
    timeout: number,
    input?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return runProcess(cmd, args, cwd, timeout, input, signal ?? this.opts.currentSignal?.() ?? null)
  }

  /** 白名单校验 + 执行模型提交的命令 */
  async execute(command: string, cwdOpt?: string, timeoutOpt?: number): Promise<RunResult> {
    const workspace = resolve(this.opts.workspace)
    const cwd = resolveSandboxPath(this.opts.sandbox, cwdOpt ?? '.', { base: workspace })
    const tokens = tokenize(command)

    if (tokens.length < 2) {
      throw new SandboxError(
        `命令不完整。只支持：node <脚本> [参数…] / python <脚本> [参数…] / py -3 <脚本> [参数…]，且脚本必须位于技能 scripts/ 目录内。`,
      )
    }

    const head = tokens[0]!
    let scriptToken: string
    let argStart: number
    let runner: { cmd: string; args: string[] } | null = null
    /** node --env-file=<path>（Node 20.6+ 官方特性；env 文件必须在沙箱内，agent 可用 Write 创建——扫榜 legacy CDP 等场景注入环境变量用） */
    let envFileArg: string | null = null

    if (head === 'node') {
      let i = 1
      if (tokens[i]?.startsWith('--env-file=')) {
        envFileArg = tokens[i]!.slice('--env-file='.length)
        i++
      } else if (tokens[i] === '--env-file') {
        envFileArg = tokens[i + 1] ?? null
        if (!envFileArg) throw new SandboxError('--env-file 缺少文件路径。')
        i += 2
      }
      scriptToken = tokens[i]!
        ?? (() => { throw new SandboxError('命令缺少脚本路径。') })()
      argStart = i + 1
      runner = { cmd: process.execPath, args: [] }
    } else if (head === 'python' || head === 'python3') {
      scriptToken = tokens[1]!
      argStart = 2
      runner = await this.python
    } else if (head === 'py') {
      if (tokens[1] !== '-3') {
        throw new SandboxError('py 命令只允许 py -3 <脚本> 形式。')
      }
      scriptToken = tokens[2]!
      argStart = 3
      runner = await this.python
    } else {
      throw new SandboxError(
        `不允许的命令 ${head}。白名单：node [--env-file=<文件>] <脚本> / python <脚本> / py -3 <脚本>，脚本须在技能 scripts/ 内。`,
      )
    }

    if (scriptToken.startsWith('-')) {
      throw new SandboxError('命令缺少脚本路径。')
    }

    // 桌面护栏：内置浏览器在线时禁止跑 setup-cdp-chrome.js——它只探测 9222 调试 Chrome，
    // 会把「内置浏览器未检测到」误判成 needs-setup 并诱导 kill 用户的常规 Chrome
    if (/setup-cdp-chrome\.js$/.test(scriptToken) && isEmbeddedBrowserActive()) {
      throw new SandboxError(
        '桌面模式（内置浏览器在线）下不要运行 setup-cdp-chrome.js：内置浏览器已在 CDP 就绪，直接调用 browser_cdp 工具（open/eval/click/login…）或运行采集脚本（内部自动读取内置浏览器端口）。setup-cdp-chrome.js 仅适用于纯浏览器模式的 9222 调试 Chrome。',
      )
    }

    // env 文件沙箱校验（必须存在且落在沙箱内，防读系统任意路径）
    if (envFileArg !== null) {
      const envAbs = resolveSandboxPath(this.opts.sandbox, envFileArg, { base: cwd })
      if (!existsSync(envAbs)) {
        throw new SandboxError(`--env-file 文件不存在：${envFileArg}（需先用 Write 在工作区创建，如 .story-studio/env.xxx）`)
      }
    }

    // 脚本路径解析：必须在技能 scripts/ 白名单内
    const preferred = this.preferredSkillDirs?.() ?? []
    const scriptAbs = this.opts.skills.resolveScript(scriptToken, cwd, preferred)
    if (!scriptAbs) {
      throw new SandboxError(
        `脚本不在白名单内：${scriptToken}。仅允许执行技能目录 scripts/ 下的脚本（如 ${[...this.opts.skills.skillScriptsDirs()].slice(0, 2).join(' 或 ')}）。`,
      )
    }

    // 参数处理：glob 展开 + 路径沙箱校验
    const rawArgs = tokens.slice(argStart)
    const finalArgs: string[] = []
    for (const arg of rawArgs) {
      if (arg.startsWith('-')) {
        finalArgs.push(arg)
        continue
      }
      const expanded = await this.expandGlob(arg, cwd)
      if (expanded.length > 0) {
        finalArgs.push(...expanded)
        continue
      }
      this.validateArgPath(arg, cwd)
      finalArgs.push(arg)
    }

    const timeout = Math.min(timeoutOpt ?? 60_000, 300_000)
    const envPrefix = envFileArg !== null ? [`--env-file=${resolveSandboxPath(this.opts.sandbox, envFileArg, { base: cwd })}`] : []
    const result = await runProcess(
      runner.cmd,
      [...runner.args, ...envPrefix, scriptAbs, ...finalArgs],
      cwd,
      timeout,
      undefined,
      this.opts.currentSignal?.() ?? null,
    )
    return {
      ...result,
      command: `${head} ${envPrefix.length ? envPrefix[0] + ' ' : ''}${scriptToken} ${finalArgs.join(' ')}`.trim(),
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
    }
  }

  /** glob 展开（相对 cwd，仅限沙箱内；无匹配返回空数组保留原文） */
  private async expandGlob(arg: string, cwd: string): Promise<string[]> {
    if (!/[*?[\]]/.test(arg)) return []
    try {
      const matches = await fg(arg, { cwd, onlyFiles: true, dot: false, unique: true })
      return matches.sort()
    } catch {
      return []
    }
  }

  /** 路径类参数必须落在沙箱内 */
  private validateArgPath(arg: string, cwd: string): void {
    const looksLikePath =
      arg.includes('/') ||
      arg.includes('\\') ||
      /\.(md|json|txt|js|ts|py|mjs|csv|log|html)$/i.test(arg) ||
      existsSync(resolve(cwd, arg))
    if (!looksLikePath) return
    resolveSandboxPath(this.opts.sandbox, arg, { base: cwd })
  }
}

/** 进程执行（UTF-8、windowsHide、超时 kill、中止信号 → 树杀） */
export function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
  input?: string,
  signal?: AbortSignal | null,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const base = { command: `${cmd} ${args.join(' ')}`, cwd }
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        ...base,
        exitCode: aborted ? 130 : timedOut ? 124 : (child.exitCode ?? -1),
        stdout,
        stderr: aborted ? `${stderr}[aborted] 用户已停止该任务，子进程已终止`.trim() : stderr,
        timedOut,
        aborted: aborted || undefined,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    /** 中止信号：用户停止 Agent / 客户端断开 → 树杀整个子进程树（含 python/execFileSync 等孙子进程） */
    const onAbort = () => {
      if (settled) return
      aborted = true
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
        }
        child.kill()
      } catch {
        /* 已退出，忽略 */
      }
      finish()
    }
    if (signal) {
      if (signal.aborted) setImmediate(onAbort)
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (stdout.length > 2_000_000) child.kill()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      if (stderr.length > 2_000_000) child.kill()
    })
    child.on('error', (err) => {
      if (settled) return
      stderr = `${stderr}${err.message}`
      finish()
    })
    child.on('close', (code) => {
      void code
      finish()
    })

    if (input !== undefined) {
      child.stdin.write(input, 'utf8')
    }
    child.stdin.end()
  })
}

export { isAbsolute }
