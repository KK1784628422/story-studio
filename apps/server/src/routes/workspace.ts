/** 工作区 API：资料库 / 追踪面板 / 快照回滚 / 章节与文档保存（编辑器通道）+ M3（inbox/file/reports）+ M4（书架） */
import type { FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chapterFilePath, listDocSections, loadTrackingPanel, resolveDocPath, scanBook } from '@story-studio/preview-core'
import { resolveSandboxPath, isProtectedDerivedPath, SandboxError, gateKindFor } from '@story-studio/tools'
import { switchBook } from '../state.ts'
import { writeLastWorkspace } from '../workspaceStore.ts'
import { watchWorkspace } from '../ws.ts'
import type { AppState } from '../state.ts'

/** 正文/大纲 前缀内的工作区相对路径 → 绝对路径（快照列表/回滚的输入校验） */
function resolveWorkPath(state: AppState, rel: string): string {
  const norm = rel.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
  if (norm.includes('..') || !(norm.startsWith('正文/') || norm.startsWith('大纲/'))) {
    throw new SandboxError(`路径不在允许范围（仅 正文/ 大纲/）：${rel}`)
  }
  return resolveSandboxPath({ workspace: state.env.workspace, skillDirs: [] }, norm)
}

/** 切换到任意绝对路径书目录：关旧监听 → 重建 → 新监听 → 广播 + 记录「上次打开」（/api/books/switch 与 /api/workspace/switch /api/spaces/* 共用） */
export async function switchTo(
  state: AppState,
  target: string,
): Promise<{ workspace: string; bookTitle: string; switched: boolean }> {
  if (resolve(target) === resolve(state.env.workspace)) {
    return { workspace: resolve(target), bookTitle: scanBook(target).title, switched: false }
  }
  await switchBook(state, target)
  state.stopWatcher = watchWorkspace(state.hub, state.env.workspace)
  const bookTitle = scanBook(state.env.workspace).title
  state.hub.emit({ type: 'book:switched', workspace: state.env.workspace, bookTitle })
  // 记住上次打开的项目：重启后直达（欢迎页可跳过）
  writeLastWorkspace(state.rootDir, state.env.workspace)
  return { workspace: state.env.workspace, bookTitle, switched: true }
}

export function registerWorkspaceRoutes(app: FastifyInstance, state: AppState): void {
  const ws = () => state.env.workspace

  /* ---------- 资料库卡片墙 ---------- */
  app.get('/api/docs', async () => ({ sections: listDocSections(ws()) }))

  /* ---------- 追踪面板 ---------- */
  app.get('/api/tracking', async () => ({ tracking: loadTrackingPanel(ws()) }))

  /* ---------- 章节编辑器保存（人工通道：快照 + 弱门禁） ---------- */
  app.put<{ Params: { index: number }; Body: { markdown?: string; expectedMtime?: number; authorApproved?: boolean } }>(
    '/api/chapter/:index',
    async (req, reply) => {
      const index = Number(req.params.index)
      const { markdown, expectedMtime, authorApproved } = req.body ?? {}
      if (typeof markdown !== 'string') {
        return reply.code(400).send({ error: 'markdown required' })
      }
      const abs = chapterFilePath(ws(), index)
      if (!abs) return reply.code(404).send({ error: `第 ${index} 章不存在` })

      // mtime 冲突检测：Agent 或其他编辑器在打开期间改过文件 → 拒绝覆盖
      const currentMtime = statSync(abs).mtimeMs
      if (typeof expectedMtime === 'number' && Math.abs(currentMtime - expectedMtime) > 1) {
        return reply.code(409).send({
          error: '文件已在别处被修改（可能是 Agent 写入），请刷新后重试',
          currentMtime,
        })
      }

      state.toolCtx.gate.snapshot(abs)
      writeFileSync(abs, markdown, 'utf8')
      // 作者手工标记「此版负责」→ 登记免检（指纹命中后门禁/质检整体跳过）
      if (authorApproved === true) state.toolCtx.gate.registerApproval(abs, 'manual')
      // 人工稿弱门禁：blocking 只提示不强拦（M2 设计：写读联动）
      const gate = await state.toolCtx.gate.runHumanGate(abs)
      return {
        ok: true,
        mtime: statSync(abs).mtimeMs,
        approved: state.toolCtx.gate.isApproved(abs),
        gate: { passed: gate.passed, report: gate.report },
      }
    },
  )

  /* ---------- 资料文档保存（大纲/设定 可写；追踪派生视图只读） ---------- */
  app.put<{ Querystring: { path: string }; Body: { markdown?: string } }>(
    '/api/doc',
    async (req, reply) => {
      const rel = req.query.path ?? ''
      const { markdown } = req.body ?? {}
      if (typeof markdown !== 'string') return reply.code(400).send({ error: 'markdown required' })
      let abs: string
      try {
        abs = resolveDocPath(ws(), rel)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
      if (rel.startsWith('追踪/')) {
        return reply.code(403).send({ error: '追踪/ 为派生视图（由 tracking 工具管理），此处只读' })
      }
      if (!existsSync(abs)) return reply.code(404).send({ error: `文档不存在：${rel}` })
      writeFileSync(abs, markdown, 'utf8')
      return { ok: true }
    },
  )

  /* ---------- 快照列表 / 回滚 ---------- */
  app.get<{ Querystring: { path?: string } }>('/api/history', async (req, reply) => {
    const rel = req.query.path ?? ''
    try {
      const abs = resolveWorkPath(state, rel)
      if (!existsSync(abs)) return reply.code(404).send({ error: `文件不存在：${rel}` })
      return { file: rel, snapshots: state.toolCtx.gate.listSnapshots(abs) }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post<{ Body: { file?: string; snapshot?: string } }>('/api/history/rollback', async (req, reply) => {
    const { file, snapshot } = req.body ?? {}
    if (!file || !snapshot) return reply.code(400).send({ error: 'file 与 snapshot 必填' })
    try {
      const abs = resolveWorkPath(state, file)
      state.toolCtx.gate.rollback(abs, snapshot)
      const mtime = existsSync(abs) ? statSync(abs).mtimeMs : null
      return { ok: true, file, snapshot, mtime }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* ---------- 文档读取（编辑器/卡墙共用，含追踪只读） ---------- */
  app.get<{ Querystring: { path: string } }>('/api/doc', async (req, reply) => {
    const rel = req.query.path ?? ''
    try {
      const abs = resolveDocPath(ws(), rel)
      if (!existsSync(abs) || !abs.startsWith(resolve(ws()))) {
        return reply.code(404).send({ error: 'not found' })
      }
      return { path: rel, markdown: readFileSync(abs, 'utf8').slice(0, 500_000) }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* ---------- M3：通用文件读取（审批卡片 diff 预览 / 报告正文，工作区沙箱内任意只读） ---------- */
  app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
    const rel = req.query.path ?? ''
    if (!rel) return reply.code(400).send({ error: 'path required' })
    try {
      const abs = resolveSandboxPath({ workspace: ws(), skillDirs: [] }, rel)
      if (!existsSync(abs) || !statSync(abs).isFile()) return reply.code(404).send({ error: 'not found' })
      const buf = readFileSync(abs)
      if (buf.length > 1_000_000) return reply.code(413).send({ error: 'file too large' })
      return { path: rel, content: buf.toString('utf8'), approved: state.toolCtx.gate.isApproved(abs) }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* ---------- 通用文件写入（资源管理器打开的文档保存） ----------
     工作区沙箱内任意文本文件（相对/绝对路径均可）；追踪/ 与 .story/作者记忆/ 派生视图禁止手改；
     已存在文件仅允许文本扩展（二进制图片等走 /api/raw，防文本通道写坏）。 */
  const TEXT_EXTS = /\.(md|markdown|txt|json|yaml|yml|csv|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|toml|ini|svg)$/i
  app.put<{ Querystring: { path?: string }; Body: { content?: string; authorApproved?: boolean } }>(
    '/api/file',
    async (req, reply) => {
      const rel = req.query.path ?? ''
      const { content, authorApproved } = req.body ?? {}
      if (!rel) return reply.code(400).send({ error: 'path required' })
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' })
      if (content.length > 1_000_000) return reply.code(413).send({ error: '文件过大（≤1MB）' })
      try {
        const abs = resolveSandboxPath({ workspace: ws(), skillDirs: [] }, rel, { forWrite: true, allowMissing: true })
        const protectedMsg = isProtectedDerivedPath(ws(), abs)
        if (protectedMsg) return reply.code(403).send({ error: protectedMsg })
        if (existsSync(abs)) {
          if (!statSync(abs).isFile()) return reply.code(400).send({ error: '不是文件' })
          const ext = (/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase()
          // TEXT_EXTS 匹配「.扩展名」形态（含点），ext 只取了字母部分 → 补点再测
          if (ext && !TEXT_EXTS.test(`.${ext}`)) {
            return reply.code(415).send({ error: `不支持编辑该类型文件（.${ext}）` })
          }
        }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, 'utf8')
        // 作者手工标记「此版负责」→ 正文文件登记免检（指纹命中后门禁/质检整体跳过）
        if (authorApproved === true && gateKindFor(ws(), abs) === 'full') {
          state.toolCtx.gate.registerApproval(abs, 'manual')
        }
        return { ok: true, mtime: existsSync(abs) ? statSync(abs).mtimeMs : null }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  /* ---------- 人物头像（人物关系网）：设定/头像/{名字}.{ext} ---------- */
  const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
  const AVATAR_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  }
  const badAvatarName = (n: string): boolean => !n || n.length > 30 || /[\\/:*?"<>|]/.test(n) || n.includes('..')

  // 读取：按名字试各扩展，命中即回二进制（前端 <img>/<image href> 直用；404=未上传）
  app.get<{ Querystring: { name?: string } }>('/api/avatar', async (req, reply) => {
    const name = (req.query.name ?? '').trim()
    if (badAvatarName(name)) return reply.code(400).send({ error: 'bad name' })
    for (const ext of AVATAR_EXTS) {
      const abs = join(ws(), '设定', '头像', `${name}.${ext}`)
      if (!existsSync(abs)) continue
      const buf = readFileSync(abs)
      if (buf.length === 0 || buf.length > 5_000_000) continue
      return reply.type(AVATAR_MIME[ext]!).send(buf)
    }
    return reply.code(404).send({ error: 'avatar not found' })
  })

  // 上传：JSON base64 dataUrl（≤5MB），写 设定/头像/{名字}.{ext}；同名旧格式清理
  app.post<{ Body: { name?: string; dataUrl?: string } }>('/api/avatar', async (req, reply) => {
    const { name, dataUrl } = req.body ?? {}
    if (typeof name !== 'string' || badAvatarName(name.trim())) {
      return reply.code(400).send({ error: 'bad name' })
    }
    const clean = name.trim()
    const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(dataUrl ?? '')
    if (!m) return reply.code(400).send({ error: '仅支持 png/jpeg/webp/gif 图片' })
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]!
    const buf = Buffer.from(m[2]!, 'base64')
    if (buf.length === 0) return reply.code(400).send({ error: 'empty image' })
    if (buf.length > 5_000_000) return reply.code(413).send({ error: '图片超过 5MB' })
    const dir = join(ws(), '设定', '头像')
    mkdirSync(dir, { recursive: true })
    for (const e of AVATAR_EXTS) {
      const old = join(dir, `${clean}.${e}`)
      if (existsSync(old)) {
        try { unlinkSync(old) } catch { /* 忽略：残留旧格式不影响展示（读序优先级一致） */ }
      }
    }
    const file = join(dir, `${clean}.${ext}`)
    writeFileSync(file, buf)
    return { ok: true, path: `设定/头像/${clean}.${ext}`, bytes: buf.length }
  })

  /* ---------- 二进制文件读取（图片预览等）：工作区沙箱内，仅图片扩展，≤20MB ---------- */
  const RAW_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
  }
  app.get<{ Querystring: { path?: string } }>('/api/raw', async (req, reply) => {
    const rel = req.query.path ?? ''
    if (!rel) return reply.code(400).send({ error: 'path required' })
    const ext = (/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase()
    const mime = RAW_MIME[ext]
    if (!mime) return reply.code(415).send({ error: '仅支持图片文件' })
    try {
      const abs = resolveSandboxPath({ workspace: ws(), skillDirs: [] }, rel)
      if (!existsSync(abs) || !statSync(abs).isFile()) return reply.code(404).send({ error: 'not found' })
      const buf = readFileSync(abs)
      if (buf.length > 20_000_000) return reply.code(413).send({ error: 'file too large (≤20MB)' })
      return reply.type(mime).send(buf)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* ---------- M3：导入向导草稿落盘（.story-studio/inbox/） ---------- */
  app.post<{ Body: { markdown?: string; title?: string } }>('/api/inbox', async (req, reply) => {
    const { markdown, title } = req.body ?? {}
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return reply.code(400).send({ error: 'markdown required' })
    }
    const safe = (title ?? 'draft').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'draft'
    const dir = join(ws(), '.story-studio', 'inbox')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `${safe}-${ts}.md`)
    writeFileSync(file, markdown, 'utf8')
    return { ok: true, path: `.story-studio/inbox/${safe}-${ts}.md`, bytes: markdown.length }
  })

  /** 导入草稿队列：inbox 下的历史草稿（mtime 倒序；正文经 /api/file 读取） */
  app.get('/api/inbox', async () => {
    const dir = join(ws(), '.story-studio', 'inbox')
    const drafts: Array<{ name: string; path: string; mtime: number; bytes: number }> = []
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue
        const abs = join(dir, name)
        const st = statSync(abs)
        if (!st.isFile()) continue
        drafts.push({ name, path: `.story-studio/inbox/${name}`, mtime: st.mtimeMs, bytes: st.size })
      }
      drafts.sort((a, b) => b.mtime - a.mtime)
    }
    return { drafts }
  })

  /* ---------- M3：审稿/扫榜报告（.story-studio/reports/ 列表） ---------- */
  app.get('/api/reports', async () => {
    const dir = join(ws(), '.story-studio', 'reports')
    const reports: Array<{ name: string; path: string; mtime: number; bytes: number }> = []
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue
        const abs = join(dir, name)
        const st = statSync(abs)
        if (!st.isFile()) continue
        reports.push({ name, path: `.story-studio/reports/${name}`, mtime: st.mtimeMs, bytes: st.size })
      }
      reports.sort((a, b) => b.mtime - a.mtime)
    }
    return { reports }
  })

  /* ---------- M4：书架（多书管理） ---------- */

  /** 候选书判定：目录下存在 正文/ 追踪/ 大纲/ 任一 oh-story 标准子目录 */
  const isBookDir = (abs: string): boolean =>
    ['正文', '追踪', '大纲'].some((d) => existsSync(join(abs, d)))

  app.get('/api/books', async () => {
    const wsAbs = resolve(ws())
    const parent = dirname(wsAbs)
    const seen = new Set<string>()
    const books: Array<{ dir: string; name: string; title: string; current: boolean }> = []

    const push = (abs: string, title?: string) => {
      const key = resolve(abs)
      if (seen.has(key)) return
      seen.add(key)
      const fallback = key.split('\\').pop() || key
      books.push({
        dir: key,
        name: title || fallback,
        title: title || fallback,
        current: key === wsAbs,
      })
    }

    // ① 空间目录 books.json：最近打开记录（跨任意父目录，最多 20 条）
    try {
      const raw = readFileSync(join(state.env.spaceDir, 'books.json'), 'utf8').replace(/^\uFEFF/, '')
      const records = JSON.parse(raw) as Array<{ path: string; title?: string }>
      for (const r of records) {
        if (!r?.path || !existsSync(r.path) || !isBookDir(r.path)) continue
        push(resolve(r.path), r.title)
      }
    } catch {
      // 无记录文件则跳过
    }

    // ② 当前父目录一级子目录扫描（books.json 未覆盖的邻居书）
    if (existsSync(parent)) {
      for (const name of readdirSync(parent)) {
        if (name.startsWith('.') || name === 'node_modules') continue
        const abs = join(parent, name)
        try {
          if (!statSync(abs).isDirectory() || !isBookDir(abs)) continue
        } catch {
          continue
        }
        push(resolve(abs), scanBook(abs).title || name)
      }
    }

    books.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name, 'zh'))
    return { parent, books }
  })

  app.post<{ Body: { dir?: string } }>('/api/books/switch', async (req, reply) => {
    const dir = (req.body?.dir ?? '').trim()
    if (!dir) return reply.code(400).send({ error: 'dir required' })
    if (dir.includes('..') || dir.includes('/') || dir.includes('\\') || /^[a-zA-Z]:/.test(dir)) {
      return reply.code(400).send({ error: '仅允许当前工作区父目录下的一级子目录名' })
    }
    const target = join(dirname(resolve(ws())), dir)
    if (!existsSync(target) || !isBookDir(target)) {
      return reply.code(404).send({ error: `不是有效的书目录（缺 正文/追踪/大纲 之一）：${dir}` })
    }
    const r = await switchTo(state, target)
    return { ok: true, workspace: r.workspace, bookTitle: r.bookTitle, switched: r.switched }
  })

  /* ---------- M5：工作区绝对路径切换（启动欢迎页 / 自定义目录） ---------- */
  /** 书工程判定：存在 正文/大纲/设定/追踪 或 .story-studio 任一子目录 */
  const isStoryDir = (abs: string): boolean =>
    ['正文', '大纲', '设定', '追踪', '.story-studio'].some((d) => existsSync(join(abs, d)))

  app.post<{ Body: { path?: string } }>('/api/workspace/switch', async (req, reply) => {
    const raw = (req.body?.path ?? '').trim()
    if (!raw) return reply.code(400).send({ error: 'path required' })
    const target = resolve(raw)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return reply.code(404).send({ error: `目录不存在：${raw}` })
    }
    if (resolve(dirname(target)) === target) {
      return reply.code(400).send({ error: `不能把盘符根目录作为工作区：${raw}` })
    }
    if (!isStoryDir(target)) {
      return reply.code(400).send({ error: `该目录不是小说工程（缺 正文/大纲/设定/追踪 或 .story-studio）：${raw}` })
    }
    const r = await switchTo(state, target)
    return { ok: true, workspace: r.workspace, bookTitle: r.bookTitle, switched: r.switched }
  })
}
