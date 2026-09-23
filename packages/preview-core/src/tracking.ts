/**
 * 追踪面板数据：解析 追踪/_tracking-state.json（唯一权威）为前端四标签结构。
 * 角色状态 / 伏笔台账 / 时间线 / 章节记录（逐章记录文件清单 + state 概要）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { TrackingPanelData } from '@story-studio/shared'

interface StateShape {
  book_title?: string
  state_revision?: number
  last_committed_chapter?: number
  imported_through_chapter?: number
  characters?: Record<
    string,
    {
      identity?: string
      location?: string
      goal?: string
      state?: string
      abilities_resources?: string[]
      knowledge?: string[]
      open_threads?: string[]
      relationships?: string[]
      updated_chapter?: number
    }
  >
  foreshadow?: Record<string, {
    id?: string
    summary?: string
    planted_chapter?: number
    planned_resolution_chapter?: number | null
    status?: string
    importance?: string
  }> | Array<{
    id?: string
    summary?: string
    planted_chapter?: number
    planned_resolution_chapter?: number | null
    status?: string
    importance?: string
  }>
  timeline?: Record<string, {
    id?: string
    story_time?: string
    objective_fact?: string
    reader_knowledge?: string
    reveal_status?: string
    reveal_chapter?: number | null
    characters?: string[]
  }> | Array<{
    id?: string
    story_time?: string
    objective_fact?: string
    reader_knowledge?: string
    reveal_status?: string
    reveal_chapter?: number | null
    characters?: string[]
  }>
  context?: {
    position?: { volume?: string; story_time?: string; scene?: string }
    long_term_constraints?: string[]
    active_character_names?: string[]
    continuity_risks?: string[]
    next_chapter_commitments?: string[]
  }
}

export function loadTrackingPanel(workspace: string): TrackingPanelData | null {
  const ws = resolve(workspace)
  const stateFile = join(ws, '追踪', '_tracking-state.json')
  if (!existsSync(stateFile)) return null
  let state: StateShape
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as StateShape
  } catch {
    return null
  }

  /** 兼容字典（id→对象，实际格式）与数组两种形态 */
  const toList = <T,>(v: Record<string, T> | T[] | undefined): T[] =>
    Array.isArray(v) ? v : v ? Object.values(v) : []

  const characters = Object.entries(state.characters ?? {}).map(([name, c]) => ({
    name,
    identity: c.identity ?? '',
    location: c.location ?? '',
    goal: c.goal ?? '',
    state: c.state ?? '',
    abilities: c.abilities_resources ?? [],
    knowledge: c.knowledge ?? [],
    openThreads: c.open_threads ?? [],
    relationships: c.relationships ?? [],
    updatedChapter: c.updated_chapter ?? null,
  }))

  const foreshadows = toList(state.foreshadow).map((f) => ({
    id: f.id ?? '',
    summary: f.summary ?? '',
    plantedChapter: f.planted_chapter ?? null,
    plannedResolution: f.planned_resolution_chapter ?? null,
    status: f.status ?? '',
    importance: f.importance ?? '',
  }))

  const timeline = toList(state.timeline).map((t) => ({
    id: t.id ?? '',
    storyTime: t.story_time ?? '',
    objectiveFact: t.objective_fact ?? '',
    readerKnowledge: t.reader_knowledge ?? '',
    revealStatus: t.reveal_status ?? '',
    revealChapter: t.reveal_chapter ?? null,
    characters: t.characters ?? [],
  }))

  const recordsDir = join(ws, '追踪', '逐章记录')
  const chapterRecords = existsSync(recordsDir)
    ? readdirSync(recordsDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : []

  return {
    bookTitle: state.book_title ?? '',
    revision: state.state_revision ?? null,
    lastCommittedChapter: state.last_committed_chapter ?? null,
    importedThroughChapter: state.imported_through_chapter ?? null,
    characters,
    foreshadows,
    timeline,
    chapterRecords,
    context: {
      volume: state.context?.position?.volume ?? '',
      storyTime: state.context?.position?.story_time ?? '',
      scene: state.context?.position?.scene ?? '',
      longTermConstraints: state.context?.long_term_constraints ?? [],
      activeCharacterNames: state.context?.active_character_names ?? [],
      continuityRisks: state.context?.continuity_risks ?? [],
      nextChapterCommitments: state.context?.next_chapter_commitments ?? [],
    },
  }
}
