/**
 * 同人衍生模式 API（四步制：1 设定 → 2 拆书 → 3 卷纲与细纲 → 4 创作）：
 * ① POST /api/fanfic/source   —— 上传原著原文（前端已完成编码检测转码，这里只落盘 + 登记卷）
 * ② GET  /api/fanfic/progress —— 读 原著/_progress.json（v2；旧 v1 自动迁移）+ 磁盘派生真值
 * ③ GET  /api/fanfic/files    —— 设定文件分组清单（原著设定 / 专属设定，第 1 步浏览器数据源）
 * ④ GET  /api/fanfic/volume   —— 单卷拆书详情（桥段摘要 + 时间线/角色发展/总结聚合产物）
 * ⑤ POST /api/fanfic/confirm        —— 面板确认拆书卷（volumes[].status=confirmed，回传缺失的聚合产物）
 * ⑥ POST /api/fanfic/advance        —— 面板推进步骤（带前置守卫：进 3 需已确认卷、进 4 需已确认细纲章）
 * ⑦ POST /api/fanfic/fork           —— 同人分岔点标记（写 volumes[].forkEvent；面板卷详情「时间线」页签点选）
 * ⑧ POST /api/fanfic/volume-create  —— 新建本书卷（拆书页弹窗：对应原著卷可多选 + 卷名 + 预计章节数）
 * ⑨ POST /api/fanfic/chapters-confirm —— 细纲逐章确认（ficVolumes[].confirmedChapters 增删）
 * 进度文件 _progress.json 为双写者：agent 经 Write/Edit 维护状态与产物字段；面板接口写
 * volumes[].status / step / s3.ficVolumes（含 confirmedChapters）。写入统一走原子替换（tmp+rename），
 * 损坏文件先备份再视为不存在，避免静默清零。摘要计数不在写路径维护——摘要文件存在即真值。
 */
import type { FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FanficFileGroup, FanficProgress, FanficVolumeProgress } from '@story-studio/shared'
import type { AppState } from '../state.ts'
import { localTimestamp } from '../log.ts'

/** 卷登记条目（agent 与上传/确认接口共同维护） */
interface VolumeEntry {
  id: number
  label: string
  source: string
  chapters: number
  summarized: number
  status: string
  timelineThrough: string
  /** 同人分岔点（面板卷详情「时间线」上点选的事件文本；第 3 步卷纲据此展开同人轨） */
  forkEvent: string
}

/** 本书卷条目（同人的分卷：对应多原著拆书卷，细纲按章确认） */
interface FicVolumeEntry {
  id: number
  name: string
  chapters: number
  sourceVolumes: number[]
  /** 卷目录（大纲/第{id}卷_{卷名}）：卷纲.md 与本卷细纲都在这里 */
  dir: string
  confirmedChapters: number[]
}

/** 本书卷目录名（id 保证唯一与排序，卷名做文件名安全化） */
const safeVolDir = (id: number, name: string): string => {
  const safe = name
    .replace(/[\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/\.+$/, '')
    .slice(0, 20)
  return `大纲/第${id}卷${safe ? `_${safe}` : ''}`
}

/** 进度文件 v2 结构（四步制；agent 与面板接口共同维护） */
interface ProgressFile {
  schemaVersion: 2
  meta: { title: string; author: string; totalChars: number; updatedAt: string }
  step: number
  steps: {
    s1: { status: string; substep: 'source' | 'own' }
    s2: { status: string; volumes: VolumeEntry[] }
    s3: { status: string; ficVolumes: FicVolumeEntry[] }
    s4: { status: string }
  }
}

/** 旧 v1（七步制）进度文件的最小读取结构 */
interface ProgressFileV1 {
  schemaVersion: 1
  meta: { title: string; author: string; totalChars: number; updatedAt: string }
  step: number
  steps: {
    s1?: { status?: string }
    s2?: { status?: string }
    s3?: { status?: string; volumes?: VolumeEntry[] }
    s4?: { status?: string; volume?: number; compareFile?: string }
    s5?: { status?: string; volume?: number; total?: number }
    s6?: { status?: string }
    s7?: { status?: string }
  }
}

function emptyProgress(): ProgressFile {
  return {
    schemaVersion: 2,
    meta: { title: '', author: '', totalChars: 0, updatedAt: localTimestamp() },
    step: 1,
    steps: {
      s1: { status: 'pending', substep: 'source' },
      s2: { status: 'pending', volumes: [] },
      s3: { status: 'pending', ficVolumes: [] },
      s4: { status: 'pending' },
    },
  }
}

/** v1 七步 → v2 四步映射：1 原著设定/2 专属设定 → 第 1 步；3/7 → 第 2 步；4/5 → 第 3 步；6 → 第 4 步 */
function migrateV1(d: ProgressFileV1): ProgressFile {
  const out = emptyProgress()
  out.meta = {
    title: String(d.meta?.title ?? ''),
    author: String(d.meta?.author ?? ''),
    totalChars: Number(d.meta?.totalChars ?? 0) || 0,
    updatedAt: String(d.meta?.updatedAt ?? ''),
  }
  const step = Math.min(Math.max(1, d.step | 0), 7)
  const volumes = Array.isArray(d.steps?.s3?.volumes)
    ? d.steps.s3.volumes.map((v) => ({
        id: Number(v?.id) || 0,
        label: String(v?.label ?? ''),
        source: String(v?.source ?? ''),
        chapters: Number(v?.chapters ?? 0) || 0,
        summarized: Number(v?.summarized ?? 0) || 0,
        status: String(v?.status ?? 'pending'),
        timelineThrough: String(v?.timelineThrough ?? ''),
        forkEvent: '',
      }))
    : []
  out.steps.s2.volumes = volumes
  if (step === 1) {
    out.step = 1
    out.steps.s1 = { status: String(d.steps?.s1?.status ?? 'pending'), substep: 'source' }
  } else if (step === 2) {
    out.step = 1
    out.steps.s1 = { status: String(d.steps?.s2?.status ?? 'in_progress'), substep: 'own' }
  } else if (step === 3 || step === 7) {
    out.step = 2
    out.steps.s1.status = 'done'
  } else if (step === 4 || step === 5) {
    out.step = 3
    out.steps.s1.status = 'done'
    out.steps.s2.status = volumes.some((v) => v.status === 'confirmed') ? 'in_progress' : 'pending'
    out.steps.s3.status = String((step === 4 ? d.steps?.s4?.status : d.steps?.s5?.status) ?? 'in_progress')
  } else {
    out.step = 4
    out.steps.s1.status = 'done'
    out.steps.s2.status = 'in_progress'
    out.steps.s3.status = 'done'
    out.steps.s4.status = String(d.steps?.s6?.status ?? 'in_progress')
  }
  return out
}

const progressPath = (workspace: string) => join(workspace, '原著', '_progress.json')

/** 原子写 JSON：tmp + rename，避免并发/崩溃留下半截文件 */
function saveProgress(workspace: string, progress: ProgressFile): void {
  progress.meta.updatedAt = localTimestamp()
  const file = progressPath(workspace)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(progress, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // rename 失败（Windows 偶发占用）退回直接写
    writeFileSync(file, JSON.stringify(progress, null, 2), 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 读进度文件：v2 直接规范化返回；v1 迁移为 v2 并原子回写（agent 文档已升级四步，落盘保持一致）；
 * 损坏 → 备份为 _progress.json.corrupt-{时间戳} 后视为不存在（不静默清零用户数据）。
 */
function loadProgress(workspace: string): ProgressFile | null {
  const file = progressPath(workspace)
  if (!existsSync(file)) return null
  let raw: string
  try {
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
  let data: Partial<ProgressFile> & Partial<ProgressFileV1>
  try {
    data = JSON.parse(raw)
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      renameSync(file, backup)
      console.warn(`[fanfic] _progress.json 损坏，已备份到 ${backup}`)
    } catch {
      console.warn('[fanfic] _progress.json 损坏且备份失败')
    }
    return null
  }
  if (data.schemaVersion === 1) {
    const migrated = migrateV1(data as ProgressFileV1)
    try {
      saveProgress(workspace, migrated)
    } catch {
      /* 迁移回写失败不阻塞读取 */
    }
    return migrated
  }
  // v2 规范化（缺字段补默认值，容忍 agent 手写遗漏）
  const base = emptyProgress()
  return {
    schemaVersion: 2,
    meta: {
      title: String(data.meta?.title ?? ''),
      author: String(data.meta?.author ?? ''),
      totalChars: Number(data.meta?.totalChars ?? 0) || 0,
      updatedAt: String(data.meta?.updatedAt ?? ''),
    },
    step: Math.min(Math.max(1, Number(data.step) || 1), 4),
    steps: {
      s1: {
        status: String(data.steps?.s1?.status ?? base.steps.s1.status),
        substep: data.steps?.s1?.substep === 'own' ? 'own' : 'source',
      },
      s2: {
        status: String(data.steps?.s2?.status ?? 'pending'),
        volumes: Array.isArray(data.steps?.s2?.volumes)
          ? data.steps.s2.volumes.map((v) => ({
              id: Number(v?.id) || 0,
              label: String(v?.label ?? ''),
              source: String(v?.source ?? ''),
              chapters: Number(v?.chapters ?? 0) || 0,
              summarized: Number(v?.summarized ?? 0) || 0,
              status: String(v?.status ?? 'pending'),
              timelineThrough: String(v?.timelineThrough ?? ''),
              forkEvent: String(v?.forkEvent ?? ''),
            }))
          : [],
      },
      s3: {
        status: String(data.steps?.s3?.status ?? 'pending'),
        ficVolumes: Array.isArray(data.steps?.s3?.ficVolumes)
          ? data.steps.s3.ficVolumes.map((v) => ({
              id: Number(v?.id) || 0,
              name: String(v?.name ?? ''),
              chapters: Number(v?.chapters ?? 0) || 0,
              sourceVolumes: Array.isArray(v?.sourceVolumes) ? v.sourceVolumes.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
              dir: String(v?.dir ?? '') || safeVolDir(Number(v?.id) || 0, String(v?.name ?? '')),
              confirmedChapters: Array.isArray(v?.confirmedChapters)
                ? [...new Set(v.confirmedChapters.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
                : [],
            }))
          : [],
      },
      s4: { status: String(data.steps?.s4?.status ?? 'pending') },
    },
  }
}

/** 摘要文件名 → 覆盖章号集合：支持「第001-015章」「第001章-第015章」「第001~015章」等区间形态与单章形态 */
function chaptersCoveredBy(name: string): Set<number> {
  const out = new Set<number>()
  const nums = [...name.matchAll(/(\d{1,5})/g)].map((m) => Number(m[1]))
  if (nums.length === 0) return out
  if (nums.length === 1) {
    out.add(nums[0]!)
    return out
  }
  // 区间形态取前两个数字（文件名规范为「第NNN-MMM章.md」；含年份等多数字形态按首区间容错）
  const [a, b] = nums
  if (b! - a! > 2000) {
    // 防御：前两个数字不成区间（如「第12章_共2部」）→ 只计单章，不整段爆扫描
    out.add(a!)
    return out
  }
  for (let n = Math.min(a!, b!); n <= Math.max(a!, b!); n++) out.add(n)
  return out
}

/** 数某卷已摘要覆盖的章数（断点真值：桥段摘要文件「第NNN-MMM章.md」存在 = 区间内各章已处理） */
function countSummaries(workspace: string, volumeId: number): number {
  const dir = join(workspace, '原著', '拆书', `第${volumeId}卷`, '摘要')
  if (!existsSync(dir)) return 0
  const covered = new Set<number>()
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.md')) continue
      for (const c of chaptersCoveredBy(n)) covered.add(c)
    }
  } catch {
    return 0
  }
  return covered.size
}

/** 某卷章节数：优先取切片产出的 边界.json 长度（真值），回退进度记录值 */
function countChapters(workspace: string, volumeId: number, fallback: number): number {
  const file = join(workspace, '原著', '拆书', `第${volumeId}卷`, '边界.json')
  if (existsSync(file)) {
    try {
      const arr = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown[]
      if (Array.isArray(arr) && arr.length > 0) return arr.length
    } catch {
      /* 损坏回退 */
    }
  }
  return fallback
}

/** 列目录下 .md 文件（含一层子目录，可排除子目录），返回排序后的元数据清单 */
function listMdFiles(absDir: string, relPrefix: string, excludeDirs: string[] = []): Array<FanficFileGroup['files'][number]> {
  const out: FanficFileGroup['files'][number][] = []
  if (!existsSync(absDir)) return out
  try {
    for (const name of readdirSync(absDir).sort()) {
      const abs = join(absDir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isFile() && name.endsWith('.md')) {
        out.push({ name, path: `${relPrefix}${name}`, bytes: st.size, mtime: st.mtimeMs })
      } else if (st.isDirectory() && !excludeDirs.includes(name)) {
        for (const sub of readdirSync(abs).sort()) {
          const subAbs = join(abs, sub)
          let subSt
          try {
            subSt = statSync(subAbs)
          } catch {
            continue
          }
          if (subSt.isFile() && sub.endsWith('.md')) {
            out.push({ name: `${name}/${sub}`, path: `${relPrefix}${name}/${sub}`, bytes: subSt.size, mtime: subSt.mtimeMs })
          }
        }
      }
    }
  } catch {
    /* 目录读取失败 → 空清单 */
  }
  return out
}

/** 读文本文件全文（不存在/失败 → null） */
function readTextIfExists(abs: string, maxBytes = 512 * 1024): string | null {
  if (!existsSync(abs)) return null
  try {
    if (statSync(abs).size > maxBytes) return readFileSync(abs, 'utf8').slice(0, 100_000) + '\n…（文件过大，已截断展示）'
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 目录下 .md 文件清单（面板展示用，带大小/时间） */
function listDirMd(absDir: string, relPrefix: string): Array<{ name: string; path: string; bytes: number; mtime: number }> {
  const out: Array<{ name: string; path: string; bytes: number; mtime: number }> = []
  if (!existsSync(absDir)) return out
  try {
    for (const name of readdirSync(absDir).sort()) {
      const abs = join(absDir, name)
      const st = statSync(abs)
      if (!st.isFile() || !name.endsWith('.md')) continue
      out.push({ name, path: `${relPrefix}${name}`, bytes: st.size, mtime: st.mtimeMs })
    }
  } catch {
    /* 忽略 */
  }
  return out
}

export function registerFanficRoutes(app: FastifyInstance, state: AppState): void {
  const ws = () => state.env.workspace

  /* ---------- 上传原著原文（单卷 ≤2.2M 字符；前端已转 UTF-8） ---------- */
  app.post<{ Body: { content?: string; filename?: string; volumeNo?: number; volumeLabel?: string } }>(
    '/api/fanfic/source',
    async (req, reply) => {
      const { content, filename, volumeNo, volumeLabel } = req.body ?? {}
      if (typeof content !== 'string' || content.trim().length < 1000) {
        return reply.code(400).send({ error: 'content 必填且至少 1000 字符（原文过短，疑似选错文件）' })
      }
      if (content.length > 2_200_000) {
        return reply.code(413).send({ error: `原文过长（${content.length} 字符 > 220 万上限，约 2MB/60 万字）——请按卷拆分后分次上传` })
      }
      const vol = Math.round(Number(volumeNo ?? 1))
      if (!Number.isInteger(vol) || vol < 1 || vol > 99) {
        return reply.code(400).send({ error: 'volumeNo 必须为 1-99 的整数' })
      }
      // 文件名：优先用户传入（安全化），否则 第N卷；处理 Windows 保留名
      let safe = (filename ?? `第${vol}卷`)
        .replace(/\.txt$/i, '')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/\.+$/, '')
        .slice(0, 50)
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = `_${safe}`
      if (!safe) safe = `第${vol}卷`

      const rel = `原著/原文/${safe}.txt`
      const abs = join(ws(), '原著', '原文', `${safe}.txt`)

      const progress = loadProgress(ws()) ?? emptyProgress()
      const existing = progress.steps.s2.volumes.find((v) => v.id === vol)
      if (existing) {
        // 已有拆书产物（切片/摘要/聚合任一存在）→ 真冲突，409；
        // 未开始拆书 → 允许覆盖换文件（删旧原文、更新登记 source/label）
        const hasWork = ['章节', '摘要', '时间线.md', '角色发展.md', '总结.md'].some((p) =>
          existsSync(join(ws(), '原著', '拆书', `第${vol}卷`, p)),
        )
        if (hasWork) {
          return reply.code(409).send({ error: `第 ${vol} 卷已存在拆书产物（${existing.source}）。如需重传请先删除 原著/拆书/第${vol}卷/ 与 原著/原文/ 旧文件` })
        }
        // 覆盖：删旧原文（source 指向工作区内文件才删，防越界路径）
        if (existing.source && !existing.source.includes('..')) {
          const oldAbs = join(ws(), existing.source)
          try {
            if (existsSync(oldAbs) && statSync(oldAbs).isFile()) unlinkSync(oldAbs)
          } catch {
            /* 删旧失败不阻塞：新文件照样写入 */
          }
        }
        existing.source = rel
        existing.label = (volumeLabel ?? '').trim().slice(0, 20) || existing.label
        existing.chapters = 0
        existing.summarized = 0
        existing.status = 'pending'
        existing.timelineThrough = ''
        existing.forkEvent = ''
      } else {
        progress.steps.s2.volumes.push({
          id: vol,
          label: (volumeLabel ?? '').trim().slice(0, 20) || `第${vol}卷`,
          source: rel,
          chapters: 0,
          summarized: 0,
          status: 'pending',
          timelineThrough: '',
          forkEvent: '',
        })
      }

      mkdirSync(join(ws(), '原著', '原文'), { recursive: true })
      writeFileSync(abs, content, 'utf8')

      // 进度回写（新卷登记 / 覆盖更新统一落盘；chapters 待拆书切片后由 agent 回填）
      saveProgress(ws(), progress)

      // chokidar 监听 原著/ → file:changed kind:'source' → 前端同人面板自动刷新（无需手动 emit）
      const volLabel = existing?.label ?? `第${vol}卷`
      return { ok: true, overwrite: Boolean(existing), path: rel, bytes: Buffer.byteLength(content, 'utf8'), volumeNo: vol, label: volLabel, chars: content.length }
    },
  )

  /* ---------- 同人整体进度（_progress.json v2 + 磁盘派生真值） ---------- */
  app.get('/api/fanfic/progress', async () => {
    const workspace = ws()
    const progress = loadProgress(workspace)

    // 原文清单（独立于进度文件存在——上传即落盘）
    const sourceFiles: FanficProgress['sourceFiles'] = []
    const srcDir = join(workspace, '原著', '原文')
    if (existsSync(srcDir)) {
      try {
        for (const name of readdirSync(srcDir).sort()) {
          const abs = join(srcDir, name)
          const st = statSync(abs)
          if (!st.isFile()) continue
          sourceFiles.push({ name, path: `原著/原文/${name}`, bytes: st.size, mtime: st.mtimeMs })
        }
      } catch {
        /* 目录读取失败 → 空清单 */
      }
    }

    // 待确认设定草稿清单（agent 检索总结后先落草稿，用户确认后转正并删除）
    const draftFiles = listDirMd(join(workspace, '原著', '草稿'), '原著/草稿/')

    // 时间线对比文件清单（原著/ 根一层）
    const compareFiles: string[] = []
    const rootDir = join(workspace, '原著')
    if (existsSync(rootDir)) {
      try {
        for (const name of readdirSync(rootDir).sort()) {
          if (/^时间线对比_.+\.md$/.test(name)) compareFiles.push(`原著/${name}`)
        }
      } catch {
        /* 忽略 */
      }
    }

    if (!progress) {
      return { exists: false, step: 0, stepSub: '', meta: null, volumes: [], ficVolumes: [], compareFiles, sourceFiles, draftFiles } satisfies FanficProgress
    }

    // 卷进度派生：summarized 从摘要目录数出；chapters 优先边界.json；
    // status 按磁盘真值派生（_progress.json 的 status 可能滞后未回写）：
    //   confirmed（用户已确认）> done（summarized ≥ chapters 且 chapters>0，拆解完成）
    //   > in_progress（已有摘要）> pending
    const volumes: FanficVolumeProgress[] = progress.steps.s2.volumes.map((v) => {
      const chapters = countChapters(workspace, v.id, v.chapters)
      const summarized = countSummaries(workspace, v.id)
      const status =
        v.status === 'confirmed'
          ? 'confirmed'
          : chapters > 0 && summarized >= chapters
            ? 'done'
            : summarized > 0
              ? 'in_progress'
              : 'pending'
      return { id: v.id, label: v.label, source: v.source, chapters, summarized, status, forkEvent: v.forkEvent }
    })

    // 第 3 步子阶段派生：任一本书卷的卷纲文件已存在 → 在细纲阶段，否则在卷纲阶段
    const stepSub =
      progress.step === 1
        ? progress.steps.s1.substep
        : progress.step === 3
          ? progress.steps.s3.ficVolumes.some(
              (v) => existsSync(join(workspace, v.dir, '卷纲.md')) || existsSync(join(workspace, '大纲', `卷纲_第${v.id}卷.md`)),
            )
            ? 'xi'
            : 'juan'
          : ''

    return {
      exists: true,
      step: progress.step,
      stepSub,
      meta: progress.meta,
      volumes,
      ficVolumes: progress.steps.s3.ficVolumes,
      compareFiles,
      sourceFiles,
      draftFiles,
    } satisfies FanficProgress
  })

  /* ---------- 第 1/3 步文件分组（原著设定 / 专属设定 / 卷纲细纲） ---------- */
  app.get('/api/fanfic/files', async (): Promise<{ groups: FanficFileGroup[] }> => {
    const workspace = ws()
    const source: FanficFileGroup['files'] = [...listMdFiles(join(workspace, '原著'), '原著/', ['草稿', '原文', '拆书'])]
    const own: FanficFileGroup['files'] = [...listMdFiles(join(workspace, '设定'), '设定/')]
    const outline: FanficFileGroup['files'] = [...listMdFiles(join(workspace, '大纲'), '大纲/')]
    return {
      groups: [
        { key: 'source', label: '原著设定', desc: '世界观 / 角色 / 势力 / 关系（来自原著拆解，宁可缺不可编）', files: source },
        { key: 'own', label: '专属设定', desc: '你的原创主角 / 金手指 / 同人类型（15 问产出）', files: own },
        { key: 'outline', label: '卷纲与细纲', desc: '总纲 / 分卷卷纲 / 逐章细纲（第 3 步产出，逐章确认）', files: outline },
      ],
    }
  })

  /* ---------- 单卷拆书详情（桥段摘要 + 聚合产物全文） ---------- */
  app.get<{ Querystring: { id?: string } }>('/api/fanfic/volume', async (req, reply) => {
    const workspace = ws()
    const id = Math.round(Number(req.query.id))
    if (!Number.isInteger(id) || id < 1 || id > 99) return reply.code(400).send({ error: 'id 必须为 1-99 的整数' })
    const progress = loadProgress(workspace)
    const entry = progress?.steps.s2.volumes.find((v) => v.id === id)
    if (!entry) return reply.code(404).send({ error: `第 ${id} 卷未登记（请先上传原文）` })

    const chapters = countChapters(workspace, id, entry.chapters)
    const summarized = countSummaries(workspace, id)
    const status =
      entry.status === 'confirmed'
        ? 'confirmed'
        : chapters > 0 && summarized >= chapters
          ? 'done'
          : summarized > 0
            ? 'in_progress'
            : 'pending'

    const volDir = join(workspace, '原著', '拆书', `第${id}卷`)
    // 摘要文件按首组数字排序（第001-008章 → 第009-015章 → …）
    const summaries = listDirMd(join(volDir, '摘要'), `原著/拆书/第${id}卷/摘要/`)
      .map((f) => ({ f, n: Number((/\d{1,5}/.exec(f.name)?.[0] ?? '999999')) }))
      .sort((a, b) => a.n - b.n)
      .map(({ f }) => ({ name: f.name, path: f.path, content: readTextIfExists(join(workspace, f.path)) ?? '（读取失败）' }))

    return {
      volume: { id, label: entry.label, source: entry.source, chapters, summarized, status, forkEvent: entry.forkEvent },
      summaries,
      artifacts: {
        timeline: readTextIfExists(join(volDir, '时间线.md')),
        characters: readTextIfExists(join(volDir, '角色发展.md')),
        summary: readTextIfExists(join(volDir, '总结.md')),
      },
    }
  })

  /* ---------- 面板确认拆书卷（volumes[].status=confirmed；回传缺失聚合产物让 agent 补齐） ---------- */
  app.post<{ Body: { volumes?: number[] } }>('/api/fanfic/confirm', async (req, reply) => {
    const ids = [...new Set((req.body?.volumes ?? []).map((n) => Math.round(Number(n))))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= 99,
    )
    if (ids.length === 0) return reply.code(400).send({ error: 'volumes 必填（1-99 卷号数组）' })
    const workspace = ws()
    const progress = loadProgress(workspace)
    if (!progress) return reply.code(400).send({ error: '同人进度尚未开始' })

    const missing: Record<string, string[]> = {}
    const notFound: number[] = []
    for (const id of ids) {
      const entry = progress.steps.s2.volumes.find((v) => v.id === id)
      if (!entry) {
        notFound.push(id)
        continue
      }
      entry.status = 'confirmed'
      const miss = ['时间线.md', '角色发展.md', '总结.md'].filter((p) => !existsSync(join(workspace, '原著', '拆书', `第${id}卷`, p)))
      if (miss.length > 0) missing[String(id)] = miss
    }
    if (notFound.length > 0) return reply.code(404).send({ error: `卷未登记：${notFound.join('、')}` })
    if (progress.step < 2) progress.step = 2
    saveProgress(workspace, progress)
    return { ok: true, missing }
  })

  /* ---------- 新建本书卷（拆书页「新建卷纲」弹窗：勾选对应原著卷 + 卷名 + 预计章节数） ---------- */
  app.post<{ Body: { name?: string; chapters?: number; sourceVolumes?: number[] } }>('/api/fanfic/volume-create', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 30)
    if (!name) return reply.code(400).send({ error: 'name 必填（本书卷名，如「第一卷」）' })
    const chapters = Math.round(Number(req.body?.chapters ?? 0))
    if (!Number.isInteger(chapters) || chapters < 1 || chapters > 9999) {
      return reply.code(400).send({ error: 'chapters 必须为 1-9999 的整数（本书卷预计章节数）' })
    }
    const sourceVolumes = [...new Set((req.body?.sourceVolumes ?? []).map((n) => Math.round(Number(n))))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= 99,
    )
    if (sourceVolumes.length === 0) return reply.code(400).send({ error: 'sourceVolumes 必填（本书卷时间线对应的原著拆书卷号，可多选）' })

    const workspace = ws()
    const progress = loadProgress(workspace)
    if (!progress) return reply.code(400).send({ error: '同人进度尚未开始' })
    const notRegistered = sourceVolumes.filter((id) => !progress.steps.s2.volumes.some((v) => v.id === id))
    if (notRegistered.length > 0) {
      return reply.code(404).send({ error: `原著卷未登记/未上传：${notRegistered.join('、')}` })
    }
    const id = progress.steps.s3.ficVolumes.reduce((m, v) => Math.max(m, v.id), 0) + 1
    const dir = safeVolDir(id, name)
    mkdirSync(join(workspace, dir), { recursive: true })
    const ficVolume = { id, name, chapters, sourceVolumes: sourceVolumes.sort((a, b) => a - b), dir, confirmedChapters: [] }
    progress.steps.s3.ficVolumes.push(ficVolume)
    if (progress.step < 3) progress.step = 3
    saveProgress(workspace, progress)
    return { ok: true, volume: ficVolume }
  })

  /* ---------- 细纲逐章确认（面板勾选 → 绿色已完善；confirmed=false = 取消确认） ---------- */
  app.post<{ Body: { volume?: number; chapters?: number[]; confirmed?: boolean } }>('/api/fanfic/chapters-confirm', async (req, reply) => {
    const volId = Math.round(Number(req.body?.volume))
    if (!Number.isInteger(volId) || volId < 1) return reply.code(400).send({ error: 'volume 必填（本书卷号）' })
    const chapters = [...new Set((req.body?.chapters ?? []).map((n) => Math.round(Number(n))))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= 9999,
    )
    if (chapters.length === 0) return reply.code(400).send({ error: 'chapters 必填（细纲章号数组）' })
    const confirmed = req.body?.confirmed !== false

    const workspace = ws()
    const progress = loadProgress(workspace)
    if (!progress) return reply.code(400).send({ error: '同人进度尚未开始' })
    const fic = progress.steps.s3.ficVolumes.find((v) => v.id === volId)
    if (!fic) return reply.code(404).send({ error: `本书第 ${volId} 卷未登记（请先在拆书页「新建卷纲」）` })
    if (confirmed) {
      fic.confirmedChapters = [...new Set([...fic.confirmedChapters, ...chapters])].sort((a, b) => a - b)
    } else {
      fic.confirmedChapters = fic.confirmedChapters.filter((c) => !chapters.includes(c))
    }
    if (progress.step < 3) progress.step = 3
    saveProgress(workspace, progress)
    return { ok: true, confirmedChapters: fic.confirmedChapters }
  })

  /* ---------- 面板推进步骤（2/3/4；前进带前置守卫，回退自由——循环拆书需要） ---------- */
  app.post<{ Body: { to?: number } }>('/api/fanfic/advance', async (req, reply) => {
    const to = Math.round(Number(req.body?.to))
    if (![2, 3, 4].includes(to)) return reply.code(400).send({ error: 'to 必须为 2/3/4' })
    const workspace = ws()
    const progress = loadProgress(workspace)
    if (!progress) return reply.code(400).send({ error: '同人进度尚未开始' })
    const confirmedVols = progress.steps.s2.volumes.filter((v) => v.status === 'confirmed').length
    if (to >= 3 && to > progress.step && confirmedVols === 0) {
      return reply.code(400).send({ error: '进入第 3 步前需先确认至少一卷拆书内容' })
    }
    if (to >= 4 && to > progress.step && !progress.steps.s3.ficVolumes.some((v) => v.confirmedChapters.length > 0)) {
      return reply.code(400).send({ error: '进入创作前需先在卷纲与细纲页确认至少一章细纲' })
    }
    progress.step = to
    saveProgress(workspace, progress)
    return { ok: true, step: to }
  })

  /* ---------- 同人分岔点（写入 volumes[].forkEvent；event 空 = 清除）。
     拆书完成后即可在面板卷详情「时间线」（原著时间线）上点选；第 3 步卷纲据此展开同人轨 ---------- */
  app.post<{ Body: { volume?: number; event?: string } }>('/api/fanfic/fork', async (req, reply) => {
    const vol = Math.round(Number(req.body?.volume))
    const event = String(req.body?.event ?? '').trim().slice(0, 120)
    if (!Number.isInteger(vol) || vol < 1 || vol > 99) return reply.code(400).send({ error: 'volume 必须为 1-99 的整数' })
    const workspace = ws()
    const progress = loadProgress(workspace)
    if (!progress) return reply.code(400).send({ error: '同人进度尚未开始' })
    const entry = progress.steps.s2.volumes.find((v) => v.id === vol)
    if (!entry) return reply.code(404).send({ error: `第 ${vol} 卷未登记（请先上传原文）` })
    entry.forkEvent = event
    saveProgress(workspace, progress)
    return { ok: true, event }
  })
}
