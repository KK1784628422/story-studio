/**
 * 门禁引擎：把 oh-story「写后必须跑 4 个脚本、blocking 清零」从提示词约定硬化为代码强制。
 * 触发：Write/Edit 命中 正文/*.md（全量门禁）或 大纲/细纲_*.md（轻量门禁）。
 * 流程：快照 → normalize-punctuation（唯一可改文件的脚本）→ 3 个只读检测并行
 *   → 全部 exit 0 = PASSED；任一 blocking = FAILED 回注 Agent Loop 定点修复 → 复检。
 * 重试上限 3 次 → 仍失败转人工（stopped）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { SkillLoader } from '@story-studio/skills'
import type { GateReport, SnapshotInfo, WsEvent } from '@story-studio/shared'
import type { BashExecutor } from './bash.ts'

export interface GateOutcome {
  passed: boolean
  attempts: number
  stopped: boolean
  message: string
  report: GateReport
}

export interface GateDeps {
  workspace: string
  skills: SkillLoader
  bash: BashExecutor
  events: { emit(event: WsEvent): void }
}

const MAX_ATTEMPTS = 3

export function chapterNumberFromPath(absPath: string): number | null {
  const m = /^第\s*0*(\d+)\s*章/.exec(basename(absPath))
  return m ? Number.parseInt(m[1]!, 10) : null
}

export class GateEngine {
  private attempts = new Map<string, number>()
  private deps: GateDeps
  /** 一次性「作者已批准」标记：chat.ts 在审批通过（polish 升华支路）后登记，下次对该文件的写入门禁直接放行并落地注册表 */
  private pendingApproval: string | null = null

  constructor(deps: GateDeps) {
    this.deps = deps
  }

  // ---------- 作者批准注册表（.story-studio/approved.json） ----------
  // 语义：注册表键=工作区相对路径，值=作者批准该版内容时的指纹（sha1）。
  // 门禁放行的条件=当前文件内容指纹与注册指纹一致；内容一旦被改（AI 后续编辑），
  // 指纹失配自动清除注册项并恢复正常门禁——保证「作者确认过的那版免检，新改动照常受检」。

  private registryPath(): string {
    return join(this.deps.workspace, '.story-studio', 'approved.json')
  }

  private readRegistry(): Record<string, { fingerprint: string; approvedAt: string; source: string }> {
    try {
      const p = this.registryPath()
      if (!existsSync(p)) return {}
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      const out: Record<string, { fingerprint: string; approvedAt: string; source: string }> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'object' && v && typeof (v as { fingerprint?: unknown }).fingerprint === 'string') {
          out[k] = v as { fingerprint: string; approvedAt: string; source: string }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  private writeRegistry(reg: Record<string, { fingerprint: string; approvedAt: string; source: string }>): void {
    mkdirSync(dirname(this.registryPath()), { recursive: true })
    writeFileSync(this.registryPath(), JSON.stringify(reg, null, 2), 'utf8')
  }

  private fingerprintOf(absPath: string): string | null {
    try {
      return createHash('sha1').update(readFileSync(absPath, 'utf8')).digest('hex')
    } catch {
      return null
    }
  }

  /** 工作区相对路径（门禁路径判定基准，与 gateKindFor 一致） */
  private relOf(absPath: string): string {
    return relative(this.deps.workspace, absPath).replaceAll('\\', '/')
  }

  /** 聊天审批放行的写入门禁免检一次（一次性；消费后即清） */
  approveNextWrite(absPath: string): void {
    this.pendingApproval = this.relOf(absPath)
  }

  /** 清空待消费的批准标记（chat.ts 每轮请求开始调用：只在检测到审批的同一轮内有效） */
  clearPendingApproval(): void {
    this.pendingApproval = null
  }

  /** 手动标记作者修改（编辑器通道），对该版内容登记免检 */
  registerApproval(absPath: string, source: 'agent-approval' | 'manual'): void {
    const fp = this.fingerprintOf(absPath)
    if (!fp) return
    const rel = this.relOf(absPath)
    const reg = this.readRegistry()
    reg[rel] = { fingerprint: fp, approvedAt: new Date().toISOString(), source }
    this.writeRegistry(reg)
  }

  /**
   * 当前文件内容是否处于「作者已批准」状态（指纹命中）。
   * 指纹失配自动清除注册项（AI 后来改过 → 免疫自动失效）。
   */
  isApproved(absPath: string): boolean {
    if (!existsSync(absPath)) return false
    const rel = this.relOf(absPath)
    if (rel.startsWith('..')) return false
    const reg = this.readRegistry()
    const entry = reg[rel]
    if (!entry) return false
    const fp = this.fingerprintOf(absPath)
    if (fp && fp === entry.fingerprint) return true
    delete reg[rel]
    this.writeRegistry(reg)
    return false
  }

  /** 作者已批准通过的合成结果（跳过脚本质检但仍发门禁事件，前端可见「作者已确认」） */
  private approvedOutcome(absPath: string): GateOutcome {
    const report: GateReport = {
      chapter: chapterNumberFromPath(absPath),
      file: this.relOf(absPath),
      passed: true,
      attempts: 1,
      stopped: false,
      scripts: [{ name: 'author-approved', exitCode: 0, output: '作者已确认（该版经作者批准/手工标记），跳过质检脚本' }],
    }
    this.deps.events.emit({ type: 'gate:result', report })
    return { passed: true, attempts: 1, stopped: false, message: 'GATE PASSED — 作者已确认（该版经作者批准/手工标记，跳过质检脚本）。', report }
  }

  private scriptDir(): string {
    const skill = this.deps.skills.get('story-long-write')
    if (!skill) throw new Error('技能 story-long-write 未加载（vendor 同步缺失）')
    return join(skill.dir, 'scripts')
  }

  /** 写入前快照 → .story-studio/history/{basename}@{ts}{ext}，保留最近 5 版 */
  snapshot(absPath: string): void {
    if (!existsSync(absPath)) return
    const histDir = join(this.deps.workspace, '.story-studio', 'history')
    mkdirSync(histDir, { recursive: true })
    const ts = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const snap = join(histDir, `${basename(absPath)}@${ts}${extname(absPath)}`)
    try {
      copyFileSync(absPath, snap)
      const prefix = `${basename(absPath)}@`
      const versions = readdirSync(histDir)
        .filter((f) => f.startsWith(prefix))
        .sort()
      while (versions.length > 5) {
        rmSync(join(histDir, versions.shift()!), { force: true })
      }
    } catch {
      // 快照失败不阻塞写入
    }
  }

  /** 正文全量门禁：4 脚本 */
  async runFullGate(absPath: string): Promise<GateOutcome> {
    const rel = this.relOf(absPath)
    // ① 一次性作者批准标记：审批通过（polish 升华支路）登记 → 该次写入免检并落地注册表
    if (this.pendingApproval === rel) {
      this.pendingApproval = null
      this.registerApproval(absPath, 'agent-approval')
      return this.approvedOutcome(absPath)
    }
    // ② 指纹命中（作者已批准该版内容）→ 跳过质检，反复运行不再重检
    if (this.isApproved(absPath)) {
      return this.approvedOutcome(absPath)
    }

    const dir = this.scriptDir()
    const ws = this.deps.workspace
    const file = absPath

    // 1. 归一化标点（写模式，唯一允许改文件的脚本）
    const normalize = await this.deps.bash.runProcessRaw(
      process.execPath,
      [join(dir, 'normalize-punctuation.js'), file],
      ws,
      30_000,
    )

    // 2. 三个只读检测并行
    const [aiPatterns, outlineCopy, degeneration] = await Promise.all([
      this.deps.bash.runProcessRaw(
        process.execPath,
        [join(dir, 'check-ai-patterns.js'), '--check', '--fail-on=blocking', file],
        ws,
        60_000,
      ),
      this.deps.bash.runProcessRaw(
        process.execPath,
        [join(dir, 'check-outline-copy.js'), file],
        ws,
        60_000,
      ),
      this.deps.bash.runProcessRaw(
        process.execPath,
        [join(dir, 'check-degeneration.js'), '--check', '--fail-on=blocking', file],
        ws,
        60_000,
      ),
    ])

    const scripts = [
      { name: 'normalize-punctuation.js', ...pick(normalize) },
      { name: 'check-ai-patterns.js', ...pick(aiPatterns) },
      { name: 'check-outline-copy.js', ...pick(outlineCopy) },
      { name: 'check-degeneration.js', ...pick(degeneration) },
    ]

    const attempts = (this.attempts.get(absPath) ?? 0) + 1
    const passed = scripts.every((s) => s.exitCode === 0)
    const stopped = !passed && attempts >= MAX_ATTEMPTS
    // 通过后复位计数：attempts 以 absPath 为 key 且永不清零会跨会话累计，
    // 同一文件累计失败 ≥3 次后即使某次修复通过，后续首次失败也会被永久判 stopped
    if (passed) this.attempts.delete(absPath)
    else this.attempts.set(absPath, attempts)

    const report: GateReport = {
      chapter: chapterNumberFromPath(absPath),
      file: relative(ws, absPath).replaceAll('\\', '/'),
      passed,
      attempts,
      stopped,
      scripts,
    }
    this.deps.events.emit({ type: 'gate:result', report })

    const message = this.formatMessage(report, scripts)
    return { passed, attempts, stopped, message, report }
  }

  /** 人工门禁（编辑器保存的正文）：4 脚本全部只读检查，blocking 只提示不强拦（不重试计数、不改文件） */
  async runHumanGate(absPath: string): Promise<GateOutcome> {
    // 作者已批准该版内容 → 人工保存也只提示「已确认」，不再跑弱门禁
    if (this.isApproved(absPath)) {
      return this.approvedOutcome(absPath)
    }
    const dir = this.scriptDir()
    const ws = this.deps.workspace
    const args = (script: string, extra: string[] = []) => [
      join(dir, script),
      ...extra,
      absPath,
    ]
    const [aiPatterns, outlineCopy, degeneration] = await Promise.all([
      this.deps.bash.runProcessRaw(process.execPath, args('check-ai-patterns.js', ['--check', '--fail-on=blocking']), ws, 60_000),
      this.deps.bash.runProcessRaw(process.execPath, args('check-outline-copy.js'), ws, 60_000),
      this.deps.bash.runProcessRaw(process.execPath, args('check-degeneration.js', ['--check', '--fail-on=blocking']), ws, 60_000),
    ])
    const scripts = [
      { name: 'check-ai-patterns.js', ...pick(aiPatterns) },
      { name: 'check-outline-copy.js', ...pick(outlineCopy) },
      { name: 'check-degeneration.js', ...pick(degeneration) },
    ]
    const report: GateReport = {
      chapter: chapterNumberFromPath(absPath),
      file: relative(ws, absPath).replaceAll('\\', '/'),
      passed: scripts.every((s) => s.exitCode === 0),
      attempts: 1,
      stopped: false,
      scripts,
    }
    return { passed: report.passed, attempts: 1, stopped: false, message: this.formatMessage(report, scripts), report }
  }

  /** 快照目录 */
  historyDir(): string {
    return join(this.deps.workspace, '.story-studio', 'history')
  }

  /** 列出某文件的全部快照（新→旧） */
  listSnapshots(absPath: string): SnapshotInfo[] {
    const histDir = this.historyDir()
    if (!existsSync(histDir)) return []
    const prefix = `${basename(absPath)}@`
    const ext = extname(absPath)
    return readdirSync(histDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .sort()
      .reverse()
      .map((f) => {
        const abs = join(histDir, f)
        const st = statSync(abs)
        return {
          file: relative(this.deps.workspace, absPath).replaceAll('\\', '/'),
          snapshot: f,
          mtime: st.mtimeMs,
          bytes: st.size,
        }
      })
  }

  /** 回滚：先把当前版本快照（留退路），再用快照覆盖目标文件 */
  rollback(absPath: string, snapshotName: string): void {
    const histDir = this.historyDir()
    const snapAbs = join(histDir, snapshotName)
    if (!existsSync(snapAbs) || snapshotName.includes('..') || snapshotName.includes('/') || snapshotName.includes('\\')) {
      throw new Error(`快照不存在：${snapshotName}`)
    }
    // 快照名必须属于目标文件（防拿 A 文件的快照覆盖 B 文件）
    if (!snapshotName.startsWith(`${basename(absPath)}@`)) {
      throw new Error(`快照 ${snapshotName} 不属于文件 ${basename(absPath)}`)
    }
    if (existsSync(absPath)) this.snapshot(absPath)
    copyFileSync(snapAbs, absPath)
  }
  /** 细纲轻量门禁：只跑 check-degeneration。
   *  ⚠ 传 --skip-meta-leak：工程词（字数目标/情节点/钩子/下一章）是细纲本职字段，
   *    正文才判违规（2026-09-02 实测：细纲模板必填「字数目标」被 meta-leak 误判 blocking 死循环）；
   *    复读/截断/占位三类退化仍查。 */
  async runLightGate(absPath: string): Promise<GateOutcome> {
    const dir = this.scriptDir()
    const ws = this.deps.workspace
    const degeneration = await this.deps.bash.runProcessRaw(
      process.execPath,
      [join(dir, 'check-degeneration.js'), '--check', '--fail-on=blocking', '--skip-meta-leak', absPath],
      ws,
      60_000,
    )
    const scripts = [{ name: 'check-degeneration.js', ...pick(degeneration) }]
    const attempts = (this.attempts.get(absPath) ?? 0) + 1
    const passed = scripts.every((s) => s.exitCode === 0)
    const stopped = !passed && attempts >= MAX_ATTEMPTS
    // 通过后复位计数：attempts 以 absPath 为 key 且永不清零会跨会话累计，
    // 同一文件累计失败 ≥3 次后即使某次修复通过，后续首次失败也会被永久判 stopped
    if (passed) this.attempts.delete(absPath)
    else this.attempts.set(absPath, attempts)
    const report: GateReport = {
      chapter: chapterNumberFromPath(absPath),
      file: relative(ws, absPath).replaceAll('\\', '/'),
      passed,
      attempts,
      stopped,
      scripts,
    }
    this.deps.events.emit({ type: 'gate:result', report })
    return { passed, attempts, stopped, message: this.formatMessage(report, scripts), report }
  }

  private formatMessage(report: GateReport, scripts: Array<{ name: string; exitCode: number; output: string }>): string {
    const lines: string[] = []
    if (report.passed) {
      lines.push('GATE PASSED — 质检全绿：')
      for (const s of scripts) {
        lines.push(`  [${s.name}] exit 0${summarizeOk(s.output)}`)
      }
      return lines.join('\n')
    }
    lines.push(
      `GATE FAILED（第 ${report.attempts}/${MAX_ATTEMPTS} 次尝试）— blocking 未清零，本章不算完成：`,
    )
    for (const s of scripts) {
      if (s.exitCode === 0) {
        lines.push(`  [${s.name}] 通过`)
      } else {
        lines.push(`  [${s.name}] exit ${s.exitCode}${s.exitCode === 2 ? '（脚本/IO 错误）' : ''}：`)
        lines.push(indent(s.output.trim(), '    '))
      }
    }
    if (report.stopped) {
      lines.push(
        '已达门禁重试上限。停止修改，向用户如实汇报以上证据，等待人工决定（继续修 / 手动改 / 回滚快照 .story-studio/history/）。',
      )
    } else {
      lines.push(
        '请按上方报告定点修复（优先 Edit 精确替换），修复后重新写入全文或用 Edit 修改——门禁会自动复检。blocking 清零前不得汇报章节完成。',
      )
    }
    return lines.join('\n')
  }
}

function pick(r: { exitCode: number; stdout: string; stderr: string }): { exitCode: number; output: string } {
  const out = [r.stdout?.trim(), r.stderr?.trim()].filter(Boolean).join('\n')
  return { exitCode: r.exitCode, output: out.slice(0, 6000) }
}

function summarizeOk(output: string): string {
  const m = /normalized \((\d+) issues?\)/.exec(output)
  if (m) return `（标点已归一 ${m[1]} 处）`
  return ''
}

function indent(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

/** 判断路径是否触发门禁 */
export function gateKindFor(workspace: string, absPath: string): 'full' | 'light' | null {
  const rel = relative(resolve(workspace), resolve(absPath)).replaceAll('\\', '/')
  if (rel.startsWith('..')) return null
  if (rel.startsWith('正文/') && rel.endsWith('.md')) return 'full'
  if (/^大纲\/细纲_第\d+章[^/]*\.md$/.test(rel)) return 'light'
  return null
}
