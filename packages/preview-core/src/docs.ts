/**
 * 资料库扫描（novel-reader DocService 的 TS 移植）：
 * 大纲/设定/追踪 三库 → 分组卡片清单（每个子目录一组，根文件归「总览」）。
 * 追踪库标记 readOnly（派生视图由 tracking 工具管理，前端只读展示）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { DocCard, DocSection } from '@story-studio/shared'

const TITLE_RE = /^#\s+(.+)$/

const SECTIONS: Array<{ key: string; dir: string; readOnly: boolean }> = [
  { key: '大纲', dir: '大纲', readOnly: false },
  { key: '设定', dir: '设定', readOnly: false },
  { key: '追踪', dir: '追踪', readOnly: true },
]

/** 允许读取/保存的顶层前缀（防路径穿越）；原著/ 供同人面板卡墙复用资料编辑器 */
export const DOC_PREFIXES = ['大纲/', '设定/', '追踪/', '原著/']

export function listDocSections(workspace: string): DocSection[] {
  const ws = resolve(workspace)
  return SECTIONS.map(({ key, dir, readOnly }) => {
    const root = join(ws, dir)
    const groups: DocGroup[] = []
    if (existsSync(root)) collectGroups(ws, root, root, groups, readOnly)
    groups.sort((a, b) => a.group.localeCompare(b.group, 'zh'))
    return { key, exists: existsSync(root), groups, readOnly }
  })
}

interface DocGroup {
  group: string
  cards: DocCard[]
}

function collectGroups(ws: string, root: string, dir: string, groups: DocGroup[], readOnly: boolean): void {
  const rel = dir === root ? '总览' : relative(root, dir).replaceAll('\\', '/')
  const cards: DocCard[] = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (!name.endsWith('.md') && !name.endsWith('.json')) continue
    cards.push({
      path: relative(ws, abs).replaceAll('\\', '/'),
      name,
      kind: name.endsWith('.json') ? 'json' : 'md',
      title: firstHeading(abs) ?? name.replace(/\.(md|json)$/, ''),
      readOnly,
      bytes: st.size,
      mtime: st.mtimeMs,
    })
  }
  if (cards.length > 0) groups.push({ group: rel, cards })
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    try {
      if (statSync(abs).isDirectory()) collectGroups(ws, root, abs, groups, readOnly)
    } catch {
      continue
    }
  }
}

function firstHeading(file: string): string | null {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 20)) {
      const m = TITLE_RE.exec(line.trim())
      if (m) return m[1]!.trim()
    }
  } catch {
    // 读取失败回退文件名
  }
  return null
}

/** 白名单解析（读取与保存共用）：仅 大纲/ 设定/ 追踪/ 前缀，拒绝 .. */
export function resolveDocPath(workspace: string, relPath: string): string {
  const ws = resolve(workspace)
  const norm = relPath.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
  if (norm.includes('..') || !DOC_PREFIXES.some((p) => norm.startsWith(p))) {
    throw new Error(`路径不在允许范围（仅 ${DOC_PREFIXES.join(' ')}）：${relPath}`)
  }
  const abs = resolve(ws, norm)
  if (!abs.startsWith(ws)) throw new Error(`路径越界：${relPath}`)
  return abs
}
