/** 上次打开的工作区持久化（.local/workspace.json）：重启后自动回到用户上次打开的书，而非 .env 死编码 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface LastWorkspace {
  workspace?: string
  at?: string
}

/** 读上次打开的工作区（无记录/解析失败返回 null） */
export function readLastWorkspace(rootDir: string): string | null {
  try {
    const file = join(rootDir, '.local', 'workspace.json')
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as LastWorkspace
    if (!parsed.workspace) return null
    return resolve(parsed.workspace)
  } catch {
    return null
  }
}

/** 记录当前打开的工作区（每次成功切书调用；写失败不影响切书） */
export function writeLastWorkspace(rootDir: string, workspace: string): void {
  try {
    const dir = join(rootDir, '.local')
    mkdirSync(dir, { recursive: true })
    const data: LastWorkspace = { workspace: resolve(workspace), at: new Date().toISOString() }
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch {
    /* 写失败不影响切书 */
  }
}
