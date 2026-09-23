/**
 * 文件沙箱：全部文件工具限制在书工作区（读写）+ 技能目录（只读）。
 * Windows 中文路径全程纯字符串操作，M0.2 验证项。
 */
import { isAbsolute, relative, resolve } from 'node:path'

export class SandboxError extends Error {}

export interface SandboxRoots {
  /** 书工作区（读写） */
  workspace: string
  /** 技能目录列表（只读） */
  skillDirs: string[]
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (isAbsolute(rel)) return false
  return rel === '' || !rel.startsWith('..')
}

/** 追踪派生文件 / 作者记忆派生视图：禁止模型手改（只能走 tracking 工具 / 脚本） */
export function isProtectedDerivedPath(workspace: string, absPath: string): string | null {
  const rel = relative(resolve(workspace), resolve(absPath))
  if (isAbsolute(rel) || rel.startsWith('..')) return null
  const norm = rel.replaceAll('\\', '/')
  if (norm === '追踪' || norm.startsWith('追踪/')) {
    return `追踪/ 下所有文件（含 _tracking-state.json 与派生视图）由 tracking 工具与脚本管理，禁止用 Write/Edit 手改。请改用 tracking 工具提交事务。`
  }
  if (norm === '.story/作者记忆' || norm.startsWith('.story/作者记忆/')) {
    return `.story/作者记忆/ 由 author_memory_commit.py 管理，禁止手改。`
  }
  return null
}

export interface ResolveOptions {
  /** 相对路径基准，默认工作区 */
  base?: string
  /** 是否写入用途（技能目录只读 → 拒绝） */
  forWrite?: boolean
  /** 允许文件不存在（Write 新建文件场景） */
  allowMissing?: boolean
}

export function resolveSandboxPath(
  roots: SandboxRoots,
  input: string,
  opts: ResolveOptions = {},
): string {
  const base = opts.base ? resolve(opts.base) : resolve(roots.workspace)
  const raw = input.trim()
  if (!raw) throw new SandboxError('路径为空')
  if (raw.includes('\0')) throw new SandboxError('路径包含非法字符')

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)

  const inWorkspace = within(roots.workspace, abs)
  const inSkillDir = roots.skillDirs.some((d) => within(d, abs))

  if (!inWorkspace && !inSkillDir) {
    throw new SandboxError(
      `路径越界：${raw} 不在书工作区 ${roots.workspace} 或技能目录内。`,
    )
  }
  if (opts.forWrite && !inWorkspace) {
    throw new SandboxError(`技能目录只读，禁止写入：${raw}`)
  }
  return abs
}

/** 路径转工作区相对展示形式（含中文目录名原样保留） */
export function toDisplayPath(workspace: string, absPath: string): string {
  const rel = relative(resolve(workspace), resolve(absPath))
  if (isAbsolute(rel) || rel.startsWith('..')) return absPath
  return rel.replaceAll('\\', '/')
}
