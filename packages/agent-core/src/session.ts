/**
 * 会话持久化：{spaceDir}/sessions/{encoded-workspace}/{id}.jsonl
 * 空间目录位于项目内（story-studio/.story-spaces），与书工作目录解耦：
 * 书目录放在任何位置（含项目外），历史会话都统一沉淀到空间目录，按工作区分目录隔离。
 * 旧版本（v5 前）存在 {workspace}/.story-studio/sessions/，首次使用时整体复制迁移，不清除旧文件。
 * AI SDK UIMessage 原样落盘；技能目录（L1）作为持久化目录消息注入会话开头（KV Cache 友好），
 * 目录变更时追加替换消息而非改写历史。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type { ModeId, SessionInfo } from '@story-studio/shared'

interface SessionMetaLine {
  t: 'meta'
  id: string
  title: string
  mode: ModeId
  createdAt: string
  updatedAt: string
}

type SessionLine =
  | SessionMetaLine
  | { t: 'ui'; message: UIMessage }
  | { t: 'catalog'; digest: string }

export interface LoadedSession {
  meta: SessionMetaLine
  messages: UIMessage[]
  catalogDigest: string | null
}

export class SessionStore {
  private dir: string
  private legacyDir: string

  constructor(workspace: string, spaceSessionsRoot: string) {
    // 空间目录按工作区隔离：{spaceRoot}/{encoded-workspace}
    this.dir = join(spaceSessionsRoot, encodeURIComponent(resolve(workspace)))
    mkdirSync(this.dir, { recursive: true })
    // 旧版本（v5 前）会话在书目录 .story-studio/sessions/，首次使用时整体迁入空间目录
    this.legacyDir = join(resolve(workspace), '.story-studio', 'sessions')
    this.migrateLegacy()
  }

  /** 一次性迁移：把书目录里的旧会话文件复制进空间目录（复制成功才清理旧目录） */
  private migrateLegacy(): void {
    if (!existsSync(this.legacyDir)) return
    let copied = 0
    try {
      for (const name of readdirSync(this.legacyDir)) {
        if (!name.endsWith('.jsonl')) continue
        const dst = join(this.dir, name)
        if (!existsSync(dst)) {
          copyFileSync(join(this.legacyDir, name), dst)
          copied++
        }
      }
    } catch {
      // 迁移失败不阻塞：新目录照常工作，旧文件留在原处
      return
    }
    if (copied > 0) {
      try {
        rmSync(this.legacyDir, { recursive: true, force: true })
      } catch {
        // 清理失败无害（读取只认空间目录）
      }
    }
  }

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return []
    const out: SessionInfo[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const loaded = this.load(name.replace(/\.jsonl$/, ''))
        if (loaded) {
          out.push({
            id: loaded.meta.id,
            title: loaded.meta.title,
            mode: loaded.meta.mode,
            createdAt: loaded.meta.createdAt,
            updatedAt: loaded.meta.updatedAt,
            messageCount: loaded.messages.length,
          })
        }
      } catch {
        // 损坏的会话文件跳过
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  load(id: string): LoadedSession | null {
    const file = this.file(id)
    if (!existsSync(file)) return null
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    let meta: SessionMetaLine | null = null
    const messages: UIMessage[] = []
    let catalogDigest: string | null = null
    for (const line of lines) {
      let parsed: SessionLine
      try {
        parsed = JSON.parse(line) as SessionLine
      } catch {
        continue
      }
      if (parsed.t === 'meta') meta = parsed
      else if (parsed.t === 'ui') messages.push(parsed.message)
      else if (parsed.t === 'catalog') catalogDigest = parsed.digest
    }
    if (!meta) return null
    return { meta, messages, catalogDigest }
  }

  create(mode: ModeId, title = '新会话', id?: string): LoadedSession {
    const now = new Date().toISOString()
    const meta: SessionMetaLine = {
      t: 'meta',
      id: id ?? randomUUID().slice(0, 8),
      title,
      mode,
      createdAt: now,
      updatedAt: now,
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(meta.id)) {
      throw new Error(`非法会话 id：${meta.id}`)
    }
    writeFileSync(this.file(meta.id), `${JSON.stringify(meta)}\n`, 'utf8')
    return { meta, messages: [], catalogDigest: null }
  }

  private rewrite(id: string, fn: (lines: SessionLine[]) => SessionLine[]): void {
    const file = this.file(id)
    if (!existsSync(file)) return
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    // 坏行容错（与 load 对齐）：单行损坏（如非原子追加中断残留半行）不阻塞整个会话的后续写入
    const parsed: SessionLine[] = []
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l) as SessionLine)
      } catch {
        /* 忽略坏行 */
      }
    }
    const out = fn(parsed)
    writeFileSync(file, out.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  }

  private touchMeta(meta: SessionMetaLine, patch?: Partial<SessionMetaLine>): SessionMetaLine {
    const updated = { ...meta, ...patch, updatedAt: new Date().toISOString() }
    return updated
  }

  setMeta(id: string, patch: Partial<Pick<SessionMetaLine, 'mode' | 'title'>>): void {
    this.rewrite(id, (lines) => {
      const idx = lines.findIndex((l) => l.t === 'meta')
      if (idx === -1) return lines
      const meta = lines[idx] as SessionMetaLine
      lines[idx] = this.touchMeta(meta, patch)
      return lines
    })
  }

  appendUi(id: string, message: UIMessage): void {
    // 复用 appendOrReplaceUi 的同 id 替换语义：并发请求（双标签页/连发）可能对同一增量消息
    // 各自 append，纯 append 会把同一条 ui 落盘两次；同 id 替换 + 末位追加保证幂等
    this.appendOrReplaceUi(id, message)
  }

  /** 追加或替换：定位最后一条 ui 行（catalog/meta 可能排在其后），同 id 替换否则追加到其后 */
  appendOrReplaceUi(id: string, message: UIMessage): void {
    this.rewrite(id, (lines) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]
        if (l?.t !== 'ui') continue
        if (l.message.id === message.id) {
          lines[i] = { t: 'ui', message }
        } else {
          lines.splice(i + 1, 0, { t: 'ui', message })
        }
        return lines
      }
      lines.push({ t: 'ui', message })
      return lines
    })
    this.setMeta(id, {})
  }

  setCatalogDigest(id: string, digest: string): void {
    this.rewrite(id, (lines) => {
      const out: SessionLine[] = lines.filter((l) => l.t !== 'catalog')
      out.push({ t: 'catalog', digest })
      return out
    })
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true })
  }

  /** 首条用户消息作为会话标题 */
  ensureTitle(session: LoadedSession, incoming: UIMessage[]): void {
    if (session.meta.title !== '新会话') return
    const firstUser = incoming.find((m) => m.role === 'user')
    if (!firstUser) return
    const text =
      firstUser.parts
        ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ')
        .slice(0, 40) ?? ''
    if (text) this.setMeta(session.meta.id, { title: text })
  }
}
