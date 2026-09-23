/**
 * 文件工具（对齐 Claude Code 命名：Read/Write/Edit/Glob/Grep/ListFiles）。
 * 沙箱：书工作区读写 + 技能目录只读；正文/细纲写入触发门禁引擎；覆盖写前自动快照。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import fg from 'fast-glob'
import { isProtectedDerivedPath, resolveSandboxPath, toDisplayPath } from './sandbox.ts'
import { gateKindFor } from './gate.ts'
import type { ToolContext } from './context.ts'

const TEXT_EXT = /\.(md|txt|json|jsonl|ya?ml|csv|html?|css|js|mjs|cjs|ts|tsx|py|sh|xml|toml|ini|env|gitignore)$/i

export function createFsTools(ctx: ToolContext): ToolSet {
  const display = (abs: string) => toDisplayPath(ctx.workspace, abs)

  /** 只读路径解析：相对路径先试工作区，再试最近加载的技能目录（SKILL.md 内的 references/xxx.md 相对形态） */
  const resolveReadPath = (path: string): string => {
    const trimmed = path.trim()
    if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) {
      return resolveSandboxPath(ctx.sandbox, trimmed)
    }
    for (const base of [resolve(ctx.workspace), ...ctx.loadedSkillDirs]) {
      const cand = resolve(base, trimmed)
      if (existsSync(cand)) return resolveSandboxPath(ctx.sandbox, cand)
    }
    return resolveSandboxPath(ctx.sandbox, trimmed)
  }

  /** 写入 + 快照 + 门禁 */
  const writeWithGate = (abs: string, content: string) => {
    const gateKind = gateKindFor(ctx.workspace, abs)
    if (gateKind) ctx.gate.snapshot(abs)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return gateKind
  }

  const gateOutcome = async (abs: string, kind: 'full' | 'light' | null) => {
    if (kind === 'full') return ctx.gate.runFullGate(abs)
    if (kind === 'light') return ctx.gate.runLightGate(abs)
    return null
  }

  const readTool = tool({
    description:
      '读取工作区内的文本文件，返回带行号内容。相对路径基于书工作区根。正文/ 默认限 400 行（防整本书塞上下文），可用 limit 提高。',
    inputSchema: z.object({
      path: z.string().describe('文件路径（相对工作区或绝对路径）'),
      offset: z.number().int().min(1).optional().describe('起始行号（1 起）'),
      limit: z.number().int().min(1).max(8000).optional().describe('行数上限'),
    }),
    execute: async ({ path, offset, limit }) => {
      const abs = resolveReadPath(path)
      const st = statSync(abs)
      if (!st.isFile()) throw new Error(`不是文件：${path}`)
      if (st.size > 4 * 1024 * 1024) throw new Error(`文件过大（${st.size} bytes）：${path}`)
      const buf = readFileSync(abs)
      if (buf.includes(0)) throw new Error(`疑似二进制文件，拒绝读取：${path}`)
      const text = buf.toString('utf8')
      const lines = text.split(/\r?\n/)
      const rel = relative(ctx.workspace, abs)
      const isProse = !rel.startsWith('..') && rel.replaceAll('\\', '/').startsWith('正文/')
      const off = offset ?? 1
      const lim = limit ?? (isProse ? 400 : 2000)
      const slice = lines.slice(off - 1, off - 1 + lim)
      return {
        path: display(abs),
        totalLines: lines.length,
        offset: off,
        limit: lim,
        truncated: off - 1 + lim < lines.length,
        content: slice.map((l, i) => `${off + i}→${l}`).join('\n'),
      }
    },
  })

  const writeTool = tool({
    description:
      '覆盖写入文件（新建或整体替换）。写入前自动快照到 .story-studio/history/（保留 5 版）。正文/第N章*.md 写入后自动触发 4 脚本门禁，blocking 必须清零；大纲/细纲_*.md 触发轻量门禁。追踪/ 下派生文件禁止手改（用 tracking 工具）。',
    inputSchema: z.object({
      path: z.string().describe('目标文件路径（相对工作区或绝对路径）'),
      content: z.string().describe('完整文件内容'),
    }),
    execute: async ({ path, content }) => {
      const abs = resolveSandboxPath(ctx.sandbox, path, { forWrite: true, allowMissing: true })
      const denied = isProtectedDerivedPath(ctx.workspace, abs)
      if (denied) throw new Error(denied)
      const kind = writeWithGate(abs, content)
      const gate = await gateOutcome(abs, kind)
      return {
        path: display(abs),
        bytes: Buffer.byteLength(content, 'utf8'),
        gate: gate ? { passed: gate.passed, attempts: gate.attempts, stopped: gate.stopped, detail: gate.message } : null,
      }
    },
  })

  const editTool = tool({
    description:
      '精确字符串替换编辑。old_string 必须唯一（或 replace_all=true）。同样触发快照与门禁。适合门禁失败后的定点修复。',
    inputSchema: z.object({
      path: z.string().describe('目标文件路径'),
      old_string: z.string().describe('要替换的原文（必须逐字匹配）'),
      new_string: z.string().describe('替换后的文本'),
      replace_all: z.boolean().optional().describe('替换全部出现（默认 false）'),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      const abs = resolveSandboxPath(ctx.sandbox, path, { forWrite: true })
      const denied = isProtectedDerivedPath(ctx.workspace, abs)
      if (denied) throw new Error(denied)
      const original = readFileSync(abs, 'utf8')
      const count = original.split(old_string).length - 1
      if (count === 0) throw new Error(`old_string 未在 ${display(abs)} 中找到。请先 Read 确认原文。`)
      if (count > 1 && !replace_all) {
        throw new Error(`old_string 出现 ${count} 次。扩大上下文使其唯一，或设 replace_all=true。`)
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string)
      const kind = writeWithGate(abs, updated)
      const gate = await gateOutcome(abs, kind)
      return {
        path: display(abs),
        replaced: replace_all ? count : 1,
        gate: gate ? { passed: gate.passed, attempts: gate.attempts, stopped: gate.stopped, detail: gate.message } : null,
      }
    },
  })

  const globTool = tool({
    description: '按 glob 模式匹配工作区文件（如 "大纲/细纲_第0*章.md"、"设定/**/*.md"）。',
    inputSchema: z.object({
      pattern: z.string().describe('glob 模式'),
      path: z.string().optional().describe('基准目录（默认工作区根）'),
    }),
    execute: async ({ pattern, path }) => {
      const base = path ? resolveReadPath(path) : resolve(ctx.workspace)
      const st = statSync(base)
      if (!st.isDirectory()) throw new Error(`基准路径不是目录：${path}`)
      const matches = await fg(pattern, { cwd: base, onlyFiles: true, dot: false, unique: true })
      const sorted = matches.sort().slice(0, 200)
      return {
        pattern,
        base: display(base),
        count: sorted.length,
        truncated: matches.length > sorted.length,
        matches: sorted,
      }
    },
  })

  const grepTool = tool({
    description:
      '正则搜索工作区文件内容。output_mode: content（默认，返回 文件:行号:内容）| files_with_matches | count。',
    inputSchema: z.object({
      pattern: z.string().describe('正则表达式（JavaScript 语法）'),
      path: z.string().optional().describe('搜索目录或文件（默认工作区根）'),
      glob: z.string().optional().describe('文件过滤 glob（默认 **/*.md 等 text 后缀）'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    }),
    execute: async ({ pattern, path, glob, output_mode }) => {
      const mode = output_mode ?? 'content'
      const base = path ? resolveReadPath(path) : resolve(ctx.workspace)
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (err) {
        throw new Error(`无效正则：${pattern}（${err instanceof Error ? err.message : err}）`)
      }
      const st = statSync(base)
      const files: string[] = st.isDirectory()
        ? (await fg(glob ?? '**/*.{md,txt,json,jsonl,py,js,ts,yaml,yml}', {
            cwd: base,
            onlyFiles: true,
            dot: false,
            unique: true,
          })).slice(0, 2000)
        : [base]
      const fileHits: Array<{ file: string; lines: Array<{ line: number; text: string }> }> = []
      for (const f of files) {
        const abs = resolve(base, f)
        let st2: ReturnType<typeof statSync>
        try {
          st2 = statSync(abs)
        } catch {
          continue
        }
        if (st2.size > 1_500_000) continue
        let text: string
        try {
          text = readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\0')) continue
        const lines: Array<{ line: number; text: string }> = []
        text.split(/\r?\n/).forEach((l, i) => {
          if (regex.test(l)) lines.push({ line: i + 1, text: l.length > 240 ? `${l.slice(0, 240)}…` : l })
        })
        if (lines.length > 0) {
          fileHits.push({ file: display(abs), lines: mode === 'content' ? lines.slice(0, 20) : lines })
        }
      }
      if (mode === 'files_with_matches') {
        return { mode, pattern, files: fileHits.map((h) => h.file), filesScanned: files.length }
      }
      if (mode === 'count') {
        return {
          mode,
          pattern,
          counts: Object.fromEntries(fileHits.map((h) => [h.file, h.lines.length])),
          filesScanned: files.length,
        }
      }
      const out = fileHits.slice(0, 100).flatMap((h) => h.lines.map((l) => `${h.file}:${l.line}:${l.text}`))
      return {
        mode,
        pattern,
        filesScanned: files.length,
        filesWithMatches: fileHits.length,
        truncated: fileHits.length > 100,
        matches: out.slice(0, 100),
      }
    },
  })

  const listFilesTool = tool({
    description: '列出目录树（深度 ≤3，含文件大小）。',
    inputSchema: z.object({
      path: z.string().optional().describe('目录（默认工作区根）'),
    }),
    execute: async ({ path }) => {
      const base = path ? resolveReadPath(path) : resolve(ctx.workspace)
      if (!statSync(base).isDirectory()) throw new Error(`不是目录：${path}`)
      const entries: string[] = []
      const walk = (dir: string, depth: number, prefix: string) => {
        if (depth > 3 || entries.length > 500) return
        let names: string[]
        try {
          names = fg.sync('*', { cwd: dir, onlyFiles: false, dot: true }).sort()
        } catch {
          return
        }
        for (const name of names) {
          if (entries.length > 500) break
          const abs = resolve(dir, name)
          const rel = prefix ? `${prefix}/${name}` : name
          let st2: ReturnType<typeof statSync>
          try {
            st2 = statSync(abs)
          } catch {
            continue
          }
          if (st2.isDirectory()) {
            entries.push(`${rel}/`)
            walk(abs, depth + 1, rel)
          } else {
            entries.push(`${rel} (${fmtBytes(st2.size)})`)
          }
        }
      }
      walk(base, 1, '')
      return { path: display(base), entries }
    },
  })

  return {
    Read: readTool,
    Write: writeTool,
    Edit: editTool,
    Glob: globTool,
    Grep: grepTool,
    ListFiles: listFilesTool,
  }
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

export { TEXT_EXT, existsSync, basename }
