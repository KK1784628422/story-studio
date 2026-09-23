/**
 * 空间目录 API（启动欢迎页驱动）：
 *   - GET  /api/spaces          空间目录信息 + 最近创作记录（books.json，最多保留 20，展示 5）
 *   - GET  /api/spaces/roots    目录树初始根（盘符根/空间目录/书父目录/项目目录）
 *   - GET  /api/spaces/tree     一层子目录列表（按需展开的目录选择器）
 *   - POST /api/spaces/open     打开书目录（任意绝对路径，校验书工程形态）
 *   - POST /api/spaces/create   新建小说（选父目录 + 书名 → 建标准工程骨架并切换）
 *   - POST /api/fs/reveal       在系统文件资源管理器中定位文件（资源管理器右键）
 *   - POST /api/fs/delete       删除工作区内文件/目录（前端已弹确认；越界路径拒绝）
 * 书目录可在任意位置（含项目外）：Agent 工具以工作区为根，技能目录独立只读。
 */
import type { FastifyInstance } from 'fastify'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { scanBook } from '@story-studio/preview-core'
import { switchTo } from './workspace.ts'
import { ensureStudioDirs } from '../env.ts'
import type { AppState } from '../state.ts'

interface BookRecord {
  path: string
  title: string
  openedAt: string
}

/** 书工程判定：存在 正文/大纲/设定/追踪 或 .story-studio 任一子目录（与 workspace.ts 口径一致） */
function isStoryDir(abs: string): boolean {
  return ['正文', '大纲', '设定', '追踪', '.story-studio'].some((d) => existsSync(join(abs, d)))
}

function booksFile(spaceDir: string): string {
  return join(spaceDir, 'books.json')
}

function loadBooks(spaceDir: string): BookRecord[] {
  try {
    // 清洗 BOM（部分编辑器/脚本写入 UTF-8 BOM 会让 JSON.parse 失败）
    const raw = readFileSync(booksFile(spaceDir), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as BookRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 置顶记录去重，最多保留 20 条 */
function addBook(spaceDir: string, workspace: string, title?: string): BookRecord[] {
  mkdirSync(spaceDir, { recursive: true })
  const ws = resolve(workspace)
  const books = loadBooks(spaceDir).filter((b) => resolve(b.path) !== ws)
  books.unshift({ path: ws, title: title ?? scanBook(ws).title, openedAt: new Date().toISOString() })
  const trimmed = books.slice(0, 20)
  writeFileSync(booksFile(spaceDir), JSON.stringify(trimmed, null, 2), 'utf8')
  return trimmed
}

/** 目录名合法化（书名 → 目录名） */
function safeDirName(title: string): string {
  return title.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || '新小说'
}

export function registerSpacesRoutes(app: FastifyInstance, state: AppState): void {
  const spaceDir = state.env.spaceDir

  app.get('/api/spaces', async () => ({ spaceDir, books: loadBooks(spaceDir) }))

  /** 目录树初始根：盘符根 + 空间目录 + 书父目录 + 项目目录 */
  app.get('/api/spaces/roots', async () => {
    const roots: Array<{ label: string; path: string }> = []
    if (process.platform !== 'win32') {
      roots.push({ label: '/', path: '/' })
    } else {
      for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${c}:\\`
        try {
          if (existsSync(p)) roots.push({ label: `${c}:`, path: p })
        } catch {
          // 不可达盘符跳过
        }
      }
    }
    roots.push({ label: '空间目录', path: spaceDir })
    roots.push({ label: '书目录所在', path: dirname(resolve(state.env.workspace)) })
    roots.push({ label: '项目目录', path: state.rootDir })
    return { roots }
  })

  /** 一层子目录 + 文件（前端按需展开，跳过隐藏与依赖目录；资源管理器/目录选择器共用） */
  app.get<{ Querystring: { root?: string } }>('/api/spaces/tree', async (req) => {
    const root = req.query.root ?? ''
    if (!root) return { error: 'root required' }
    const abs = resolve(root)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return { error: `目录不存在：${root}` }
    const dirs: string[] = []
    const files: string[] = []
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue
      const child = join(abs, name)
      try {
        if (statSync(child).isDirectory()) dirs.push(name)
        else files.push(name)
      } catch {
        // 无权限/损坏条目跳过
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh'))
    files.sort((a, b) => a.localeCompare(b, 'zh'))
    return { root: resolve(abs), dirs, files }
  })

  /** 打开书目录（任意绝对路径，须是书工程） */
  app.post<{ Body: { path?: string } }>('/api/spaces/open', async (req, reply) => {
    const raw = (req.body?.path ?? '').trim()
    if (!raw) return reply.code(400).send({ error: 'path required' })
    const target = resolve(raw)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return reply.code(404).send({ error: `目录不存在：${raw}` })
    }
    if (!isStoryDir(target)) {
      return reply.code(400).send({ error: `该目录不是小说工程（缺 正文/大纲/设定/追踪 或 .story-studio）：${raw}` })
    }
    const r = await switchTo(state, target)
    return { ok: true, workspace: r.workspace, bookTitle: r.bookTitle, switched: r.switched, books: addBook(spaceDir, target) }
  })

  /** 新建小说：父目录 + 书名 → 标准工程骨架（正文/大纲/设定/追踪 + .story-studio） */
  app.post<{ Body: { parentPath?: string; title?: string } }>('/api/spaces/create', async (req, reply) => {
    const parent = (req.body?.parentPath ?? '').trim()
    const title = (req.body?.title ?? '').trim()
    if (!parent || !title) return reply.code(400).send({ error: 'parentPath 与 title 必填' })
    const parentAbs = resolve(parent)
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
      return reply.code(404).send({ error: `父目录不存在：${parent}` })
    }
    const target = join(parentAbs, safeDirName(title))
    if (existsSync(target)) return reply.code(409).send({ error: `目录已存在：${target}` })
    for (const sub of ['正文', '大纲', '设定', '追踪']) {
      mkdirSync(join(target, sub), { recursive: true })
    }
    ensureStudioDirs(target)
    const r = await switchTo(state, target)
    return {
      ok: true,
      dir: target,
      workspace: r.workspace,
      bookTitle: r.bookTitle,
      switched: true,
      books: addBook(spaceDir, target, title),
    }
  })

  /** 工作区边界校验：解析后必须严格位于当前书工作区内。
   *  两种越界形态都要拒：同盘 `..` 上跳；跨盘（D:\ 工作区收 C:\ 路径）时
   *  path.relative 返回的是绝对路径而非 .. 开头——必须显式判 isAbsolute（实测曾绕过） */
  const insideWorkspace = (raw: string): string | null => {
    const abs = resolve(raw)
    const rel = relative(state.env.workspace, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return abs
  }

  /** 系统资源管理器定位。两个实测坑（2026-09 排查）：
   *  1. `explorer /select,<目录>` 确定性无效（不弹窗也不报错）——目录必须直接打开自身；
   *  2. 桌面版服务器跑在 Electron(as Node) 里，直接 spawn explorer 会被 Chromium Job Object
   *     吞掉窗口（原生 node 正常）——经 powershell 间接启动可脱离父进程 Job，两种环境都成功 */
  app.post<{ Body: { path?: string } }>('/api/fs/reveal', async (req, reply) => {
    const abs = insideWorkspace((req.body?.path ?? '').trim())
    if (!abs) return reply.code(400).send({ error: '路径无效或超出工作区范围' })
    if (!existsSync(abs)) return reply.code(404).send({ error: `文件不存在：${abs}` })
    try {
      const isDir = statSync(abs).isDirectory()
      if (process.platform === 'win32') {
        const esc = abs.replace(/'/g, "''") // 单引号转义防 PowerShell 注入
        const cmd = isDir ? `explorer.exe '${esc}'` : `explorer.exe /select,'${esc}'`
        spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else if (process.platform === 'darwin') {
        spawn('open', ['-R', abs], { stdio: 'ignore' })
      } else {
        spawn('xdg-open', [isDir ? abs : dirname(abs)], { stdio: 'ignore' })
      }
      return { ok: true }
    } catch (err) {
      return reply.code(500).send({ error: `打开资源管理器失败：${err instanceof Error ? err.message : String(err)}` })
    }
  })

  /** 删除工作区内文件/目录（目录递归）。前端已弹确认框；此处二次校验工作区边界 */
  app.post<{ Body: { path?: string } }>('/api/fs/delete', async (req, reply) => {
    const abs = insideWorkspace((req.body?.path ?? '').trim())
    if (!abs) return reply.code(400).send({ error: '路径无效或超出工作区范围' })
    if (!existsSync(abs)) return reply.code(404).send({ error: `文件不存在：${abs}` })
    try {
      rmSync(abs, { recursive: true, force: false })
      return { ok: true, path: abs }
    } catch (err) {
      return reply.code(500).send({ error: `删除失败：${err instanceof Error ? err.message : String(err)}` })
    }
  })
}