/**
 * 书库扫描（novel-reader LibraryService 的 TS 移植，M1 最小集）：
 * 章节：正文/第NNN章_标题.md 命名约定；书名：追踪/_tracking-state.json 的 book_title，回退目录名。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { BookInfo, ChapterBrief, ChapterContent } from '@story-studio/shared'

const CHAPTER_RE = /^第\s*0*(\d+)\s*章[\s_\-]*(.*)\.md$/i

export interface ScanResult {
  book: BookInfo
}

export function scanBook(workspace: string): BookInfo {
  const ws = resolve(workspace)
  const proseDir = join(ws, '正文')
  const chapters: ChapterBrief[] = []

  if (existsSync(proseDir)) {
    for (const name of readdirSync(proseDir).sort()) {
      const m = CHAPTER_RE.exec(name)
      if (!m || !name.endsWith('.md')) continue
      const abs = join(proseDir, name)
      let size = 0
      try {
        size = statSync(abs).size
      } catch {
        continue
      }
      chapters.push({
        index: Number.parseInt(m[1]!, 10),
        file: `正文/${name}`,
        title: m[2] ?? readTitle(abs) ?? `第${m[1]}章`,
        bytes: size,
      })
    }
  }
  chapters.sort((a, b) => a.index - b.index)

  const stateFile = join(ws, '追踪', '_tracking-state.json')
  let trackingRevision: number | null = null
  let lastCommittedChapter: number | null = null
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        state_revision?: number
        last_committed_chapter?: number
      }
      trackingRevision = typeof state.state_revision === 'number' ? state.state_revision : null
      lastCommittedChapter =
        typeof state.last_committed_chapter === 'number' ? state.last_committed_chapter : null
    } catch {
      // state 损坏时按无追踪处理
    }
  }

  return {
    title: bookTitle(ws),
    workspace: ws,
    chapters,
    latestChapter: chapters.at(-1)?.index ?? 0,
    trackingRevision,
    lastCommittedChapter,
    outlineFiles: listMd(join(ws, '大纲')),
    settingFiles: listMd(join(ws, '设定')),
    trackingFiles: listTracking(join(ws, '追踪')),
  }
}

export function readChapter(workspace: string, index: number): ChapterContent | null {
  const ws = resolve(workspace)
  const proseDir = join(ws, '正文')
  if (!existsSync(proseDir)) return null
  for (const name of readdirSync(proseDir)) {
    const m = CHAPTER_RE.exec(name)
    if (!m || Number.parseInt(m[1]!, 10) !== index) continue
    const abs = join(proseDir, name)
    const markdown = readFileSync(abs, 'utf8')
    return {
      index,
      file: `正文/${name}`,
      title: m[2] ?? readTitle(abs) ?? `第${m[1]}章`,
      markdown,
      mtime: statSync(abs).mtimeMs,
    }
  }
  return null
}

/** 定位章节文件的绝对路径（编辑器保存用） */
export function chapterFilePath(workspace: string, index: number): string | null {
  const ws = resolve(workspace)
  const proseDir = join(ws, '正文')
  if (!existsSync(proseDir)) return null
  for (const name of readdirSync(proseDir)) {
    const m = CHAPTER_RE.exec(name)
    if (m && Number.parseInt(m[1]!, 10) === index) return join(proseDir, name)
  }
  return null
}

function readTitle(abs: string): string | null {
  try {
    const first = readFileSync(abs, 'utf8').split(/\r?\n/, 1)[0] ?? ''
    const m = /^#\s*第\s*\d+\s*章[_\s]*(.*)$/.exec(first.trim())
    return m?.[1] ?? null
  } catch {
    return null
  }
}

function bookTitle(ws: string): string {
  const stateFile = join(ws, '追踪', '_tracking-state.json')
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { book_title?: string }
      if (state.book_title) return state.book_title
    } catch {
      // fallthrough
    }
  }
  return basename(ws)
}

function listMd(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => relative(resolve(join(dir, '..')), join(dir, f)).replaceAll('\\', '/'))
}

function listTracking(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 2) return
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name)
      if (statSync(abs).isDirectory()) walk(abs, depth + 1)
      else out.push(relative(resolve(join(dir, '..')), abs).replaceAll('\\', '/'))
    }
  }
  walk(dir, 0)
  return out
}
