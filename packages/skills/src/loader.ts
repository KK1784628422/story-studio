/**
 * SkillLoader：三级渐进披露（agentskills.io 开放标准）
 * L1 启动时仅注入 name + description 目录（KV Cache 友好：作为持久化目录消息置于会话开头）
 * L2 触发时 load_skill 工具读入 SKILL.md 全文
 * L3 执行中 references/ 与 scripts/ 按需读取/执行（文件工具沙箱放行技能目录只读）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface SkillMeta {
  name: string
  description: string
  dir: string
  /** 调用策略四象限（dsh 设计）：oh-story 全部默认 {true, true} */
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillContent {
  name: string
  description: string
  dir: string
  markdown: string
  tree: string[]
}

/** 解析 SKILL.md：YAML frontmatter（name/description）+ Markdown 正文 */
export function parseSkillFile(raw: string): { data: Record<string, string>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }
  const lines = normalized.split(/\r?\n/)
  const data: Record<string, string> = {}
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---' || line.trim() === '...') {
      i++
      break
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m && !(m[1]! in data)) data[m[1]!] = stripQuotes(m[2]!.trim())
  }
  return { data, body: lines.slice(i).join('\n').replace(/^\s+/, '') }
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0]!
    const last = v[v.length - 1]!
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1)
    }
  }
  return v
}

function listTree(root: string, prefix = ''): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries.sort()) {
    const abs = join(root, name)
    const rel = prefix ? `${prefix}/${name}` : name
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push(`${rel}/`)
      out.push(...listTree(abs, rel).slice(0, 200))
    } else {
      out.push(`${rel} (${fmtSize(st.size)})`)
    }
  }
  return out
}

function fmtSize(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

export class SkillLoader {
  private vendorRoot: string
  /** 本地技能根（packages/skills/local/，不参与 vendor 同步，不会被 sync-skills 冲掉） */
  private localRoot: string | null
  private metas: SkillMeta[] = []
  private byName = new Map<string, SkillMeta>()

  constructor(vendorRoot: string, localRoot?: string) {
    this.vendorRoot = resolve(vendorRoot)
    this.localRoot = localRoot ? resolve(localRoot) : null
    this.rescan()
  }

  get root(): string {
    return this.vendorRoot
  }

  /** 全部技能根（vendor + local）——沙箱只读放行、Bash 脚本解析用 */
  get roots(): string[] {
    return this.localRoot ? [this.vendorRoot, this.localRoot] : [this.vendorRoot]
  }

  rescan(): SkillMeta[] {
    this.metas = []
    this.byName.clear()
    // vendor 先扫、local 后扫：同名技能 local 覆盖 vendor（本地定制优先）
    for (const root of this.roots) {
      this.scanRoot(root)
    }
    return this.metas
  }

  private scanRoot(root: string): void {
    if (!existsSync(root)) return
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name)
      const skillFile = join(dir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      let raw: string
      try {
        raw = readFileSync(skillFile, 'utf8')
      } catch {
        continue
      }
      const { data, body } = parseSkillFile(raw)
      const meta: SkillMeta = {
        name: data.name ?? name,
        description: (data.description ?? body.split('\n')[0] ?? '').slice(0, 500),
        dir,
        // oh-story 全部技能默认双开；预留四象限
        modelInvocable: data['disable-model-invocation'] !== 'true',
        userInvocable: data['user-invocable'] !== 'false',
      }
      // 同名覆盖：先从 metas 里剔除旧条目
      if (this.byName.has(meta.name)) {
        this.metas = this.metas.filter((m) => m.name !== meta.name)
      }
      this.metas.push(meta)
      this.byName.set(meta.name, meta)
    }
  }

  list(): SkillMeta[] {
    return this.metas.filter((m) => m.modelInvocable || m.userInvocable)
  }

  get(name: string): SkillMeta | undefined {
    return this.byName.get(name)
  }

  /** L2：读入 SKILL.md 全文 + 目录树（references/scripts 清单） */
  load(name: string): SkillContent {
    const meta = this.byName.get(name)
    if (!meta) {
      throw new Error(
        `技能 ${name} 不存在。可用技能：${this.metas.map((m) => m.name).join(', ')}`,
      )
    }
    const raw = readFileSync(join(meta.dir, 'SKILL.md'), 'utf8')
    const { body } = parseSkillFile(raw)
    const tree = listTree(meta.dir).slice(0, 400)
    return { name: meta.name, description: meta.description, dir: meta.dir, markdown: body, tree }
  }

  /** 渲染为 dsh 风格的规范 skill_content 块（模型/用户调用同一形态） */
  render(content: SkillContent): string {
    const lines = [
      `<skill_content name="${content.name}">`,
      '<skill_instructions>',
      content.markdown,
      '</skill_instructions>',
      '<skill_resources>',
      `技能目录：${content.dir}`,
      ...content.tree.map((t) => `- ${t}`),
      'references 内文档按需用 Read 工具读取（绝对路径）；scripts 由 Bash 白名单执行器自动解析。',
      '</skill_resources>',
      '</skill_content>',
    ]
    return lines.join('\n')
  }

  /** 所有技能的 scripts 目录（Bash 白名单的脚本来源） */
  skillScriptsDirs(): string[] {
    return this.metas
      .map((m) => join(m.dir, 'scripts'))
      .filter((d) => existsSync(d))
  }

  /** 相对脚本路径解析：cwd 优先，其次各技能目录（最近加载的优先）。
   *  支持两种形态：`check-ai-patterns.js`（相对技能 scripts/）与 `scripts/check-ai-patterns.js`（相对技能根，SKILL.md 原文形态） */
  resolveScript(scriptPath: string, cwd: string, preferredDirs: string[] = []): string | null {
    const candidateRoots = [
      ...preferredDirs.map((d) => join(d, 'scripts')),
      ...preferredDirs,
      cwd,
      ...this.skillScriptsDirs(),
      ...this.metas.map((m) => m.dir),
    ]
    const resolved = isAbsolute(scriptPath)
      ? resolve(scriptPath)
      : candidateRoots.map((r) => resolve(r, scriptPath)).find((p) => existsSync(p)) ?? resolve(cwd, scriptPath)
    // 必须落在某个技能 scripts/ 内且存在（唯一放行区域）
    for (const dir of this.skillScriptsDirs()) {
      if (this.relWithin(dir, resolved) !== null && existsSync(resolved)) return resolved
    }
    return null
  }

  /** 目录是否包含 target（target 等于目录本身返回 ''，不包含返回 null） */
  private relWithin(dir: string, target: string): string | null {
    const rel = relative(resolve(dir), resolve(target))
    if (isAbsolute(rel) || rel.startsWith('..')) return null
    return rel
  }

  /** L1 目录清单文本（注入会话开头的持久化消息，前缀缓存友好） */
  catalogText(): string {
    const lines = [
      '<available_skills>',
      '本环境已安装以下技能（name: description）。任务与某技能相关时，先调用 load_skill 工具加载其完整 SKILL.md，严格按其流程执行；技能之间互引时同理逐个加载。',
      ...this.list().map((m) => `- ${m.name}: ${m.description}`),
      '</available_skills>',
    ]
    return lines.join('\n')
  }

  /** 目录摘要（变化检测用） */
  digest(): string {
    return this.list()
      .map((m) => `${m.name}:${m.description.length}`)
      .join('|')
  }
}
