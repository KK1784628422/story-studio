/** /api/background —— 全页面动态背景视频（上传 / 读取 / 清除）。
 *  视频以二进制存 .local/background.mp4（≤30M，MP4），设置中心「外观 · 动态背景」上传；
 *  前端全局层（App 根下 <video>）引用 /api/background/video 做整页虚化背景。 */
import type { FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../state.ts'

/** 用户可上传的上限 */
const MAX_BYTES = 100 * 1024 * 1024
/** MP4 魔数：前 4-12 字节内应出现 'ftyp' */
const MP4_MAGIC = Buffer.from('ftyp', 'ascii')

export function registerBackgroundRoutes(app: FastifyInstance, state: AppState): void {
  const dir = join(state.rootDir, '.local')
  const file = join(dir, 'background.mp4')

  const info = (): { enabled: boolean; size: number } => {
    if (!existsSync(file)) return { enabled: false, size: 0 }
    try {
      return { enabled: true, size: statSync(file).size }
    } catch {
      return { enabled: false, size: 0 }
    }
  }

  /** 元信息：是否已设置 + 文件大小（前端决定是否渲染视频层） */
  app.get('/api/background', async () => info())

  /** 视频本体：<video src="/api/background/video"> 直接流式播放 */
  app.get('/api/background/video', async (_req, reply) => {
    if (!existsSync(file)) return reply.code(404).send({ error: '背景视频未设置' })
    reply.header('content-type', 'video/mp4')
    reply.header('cache-control', 'no-cache')
    return reply.send(readFileSync(file))
  })

  /** 上传（PUT 二进制 video/mp4；前端 fetch(body=file)）：校验大小 + MP4 魔数后落盘 */
  app.put('/api/background', async (req, reply) => {
    const body = req.body
    const buf = Buffer.isBuffer(body) ? body : Buffer.isBuffer((body as Buffer)?.buffer) ? (body as Buffer) : null
    if (!buf || buf.length === 0) return reply.code(400).send({ error: '请求体为空：请以 video/mp4 二进制上传文件本体' })
    if (buf.length > MAX_BYTES) return reply.code(413).send({ error: `文件过大：动态背景仅支持不超过 100M 的 MP4（当前 ${(buf.length / 1024 / 1024).toFixed(1)}M）` })
    // MP4 以 ftyp box 开头（isom/mp42/avc1 等），防止误传其它二进制
    if (!buf.subarray(0, 12).includes(MP4_MAGIC)) {
      return reply.code(400).send({ error: '不是有效的 MP4 文件（缺少 ftyp 头）' })
    }
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(file, buf)
    } catch (err) {
      return reply.code(500).send({ error: `保存失败：${err instanceof Error ? err.message : String(err)}` })
    }
    return { ok: true, ...info() }
  })

  /** 清除背景（回退到主题静态背景） */
  app.delete('/api/background', async () => {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* 删不掉就当作已清除（前端不渲染即不显示） */
    }
    return { ok: true, enabled: false }
  })
}
