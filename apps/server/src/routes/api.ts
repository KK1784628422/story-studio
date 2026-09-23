/** 预览与配置 API：config / book / chapter / sessions / tts / 浏览器操控 */
import { aggregateUsageStats, listUsageRecords } from '../usageStats.ts'
import type { FastifyInstance } from 'fastify'
import { join } from 'node:path'
import { MODES, type ServerConfig } from '@story-studio/shared'
import { scanBook, readChapter } from '@story-studio/preview-core'
import type { AppState } from '../state.ts'
import { readPreferences } from '../env.ts'
import { submitAskAiAnswer } from '../askAiBus.ts'

export function registerApiRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/config', async () => {
    // 输入栏模型选项 = 用户在设置面板配置的全部 Provider（不再有内置默认列表）；
    // 顶栏展示的生效模型 = 激活的 Provider，未配置任何 Provider 时回退 .env
    const settings = state.settings.load()
    const active = settings.providers.find((p) => p.id === settings.activeProviderId) ?? null
    const config: ServerConfig = {
      bookTitle: scanBook(state.env.workspace).title,
      workspace: state.env.workspace,
      modelId: active ? (active.displayName ?? `${active.name}·${active.modelId}`) : state.env.modelId,
      baseUrl: state.env.baseUrl.replace(/\/\/[^/]*@/, '//***@'),
      hasApiKey: Boolean(active?.apiKey || state.env.apiKey),
      skills: state.skills.list().map((s) => ({ name: s.name, description: s.description })),
      modes: MODES,
      models: settings.providers.map((p) => {
        const free = p.kind === 'free'
        // 免费池：下拉项附「免费×N」标记（N=池内 key 数），与普通模型区分
        const baseLabel = p.displayName ?? `${p.name}·${p.modelId}`
        const keyCount = free && Array.isArray(p.apiKeys) ? p.apiKeys.length : 0
        return {
          id: p.id,
          label: free ? `${baseLabel}（免费×${keyCount}）` : baseLabel,
          modelId: p.modelId,
          // 图片输入开关（Provider 配置）：前端据此控制输入栏附件按钮/拖拽图片是否可用
          supportsImages: p.supportsImages === true,
          // 免费池标记：前端渲染 FREE 徽标（429 自动轮询换 key 的模型）
          free,
        }
      }),
      activeModelId: settings.activeProviderId,
      reasoningEfforts: [
        { id: 'max', label: '思考：极大（默认）' },
        { id: 'high', label: '思考：高' },
        { id: 'low', label: '思考：低' },
      ],
    }
    return config
  })

  app.get('/api/book', async () => scanBook(state.env.workspace))

  app.get<{ Params: { index: number } }>('/api/chapter/:index', async (req, reply) => {
    const index = Number(req.params.index)
    if (!Number.isInteger(index) || index < 0) {
      return reply.code(400).send({ error: 'invalid index' })
    }
    const chapter = readChapter(state.env.workspace, index)
    if (!chapter) return reply.code(404).send({ error: `第 ${index} 章不存在` })
    return chapter
  })

  app.get('/api/preferences', async () => ({ markdown: readPreferences(state.env.workspace) }))

  /** 模型使用统计聚合（近 7 天趋势/模型占比/今日周累计/平均耗时/模式分布） */
  app.get('/api/usage/stats', async () => aggregateUsageStats())

  /** 最近 N 条轮次记录（最新在前；设置统计页「最近任务记录」列表数据源） */
  app.get<{ Querystring: { limit?: string } }>('/api/usage/records', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    return listUsageRecords(limit)
  })

  /** 意图分类（三级命中：L0 正则 → L1 本地分类器 → L2 LLM 兜底；used 标识命中层） */
  app.post<{ Body: { text?: string; current?: string } }>('/api/route', async (req) => {
    const { text, current } = req.body ?? {}
    if (!text) return { decision: null, used: 'rules' }
    const { classifyIntent, classifyWithModel, peekLlmCache } = await import('@story-studio/agent-core')
    const currentMode = (MODES.find((m) => m.id === current)?.id ?? 'discuss') as import('@story-studio/shared').ModeId

    // L0：本地正则规则（毫秒级，绝大多数程式化指令零新增延迟）
    const rule = classifyIntent(text, currentMode)
    if (rule) return { decision: rule, used: 'rules' }

    // L1：本地轻量分类器（<2ms；conf≥0.6 直接采纳，0.3~0.6 交 L2 复核，<0.3 视为域外直接放行省 token）
    const local = state.localRouter.classify(text)
    if (local) {
      const decision = { mode: local.mode, reason: '本地意图识别' } as const
      if (local.conf >= 0.6) {
        if (local.mode !== currentMode) return { decision, used: 'local' }
        return { decision: null, used: 'local' }
      }
      if (local.conf < 0.3) return { decision: null, used: 'local' }
    }

    // L2：LLM 兜底（LRU 缓存命中 0ms；未命中 ≤5s；失败回退不切，不阻塞发送）
    try {
      const active = state.settings.getActive(state.env.baseUrl, state.env.apiKey, state.env.modelId)
      const modelConf = active
        ? { baseUrl: active.baseUrl, apiKey: active.apiKey, modelId: active.modelId }
        : { baseUrl: state.env.baseUrl, apiKey: state.env.apiKey, modelId: state.env.modelId }
      const cached = peekLlmCache(text)
      if (cached !== undefined) {
        if (cached && cached.mode !== currentMode) return { decision: cached, used: 'llm-cache' }
        return { decision: null, used: 'llm-cache' }
      }
      const llm = await classifyWithModel(text, modelConf)
      if (llm && llm.mode !== currentMode) return { decision: llm, used: 'llm' }
    } catch {
      // 兜底失败 → 保持当前模式
    }
    return { decision: null, used: 'llm' }
  })

  app.get('/api/sessions', async () => ({ sessions: state.sessions.list() }))

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const s = state.sessions.load(req.params.id)
    if (!s) return reply.code(404).send({ error: 'session not found' })
    return { id: s.meta.id, mode: s.meta.mode, title: s.meta.title, messages: s.messages }
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    state.sessions.delete(req.params.id)
    return { ok: true }
  })

  /** TTS：GET /api/tts?text=&voice=&rate=&pitch= → audio/mpeg（Edge TTS，磁盘缓存） */
  app.get<{ Querystring: { text?: string; voice?: string; rate?: string; pitch?: string } }>(
    '/api/tts',
    async (req, reply) => {
      const { text, voice, rate, pitch } = req.query
      if (!text || !text.trim()) return reply.code(400).send({ error: 'text required' })
      if (text.length > 600) return reply.code(400).send({ error: 'text 过长（≤600 字）' })
      try {
        const buf = await state.toolCtx.tts.synthesize(voice, rate, pitch, text)
        reply.header('content-type', 'audio/mpeg')
        reply.header('cache-control', 'public, max-age=31536000, immutable')
        return reply.send(buf)
      } catch (err) {
        return reply.code(502).send({ error: `TTS 合成失败：${err instanceof Error ? err.message : err}` })
      }
    },
  )

  /**
   * 桌面化内置浏览器 CDP 端口：Electron 主进程写入 .local/embedded-cdp-port，
   * 前端/tools 据此用 agent-browser --cdp <port> 连内置 BrowserView（扫榜可视化/网页AI）。
   * 非桌面模式（无端口文件）返回 available=false。
   */
  app.get('/api/embedded/cdp-port', async () => {
    const file = join(state.rootDir, '.local', 'embedded-cdp-port')
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      if (!existsSync(file)) return { available: false, port: null }
      const port = Number(readFileSync(file, 'utf8').trim())
      return Number.isInteger(port) && port > 0 ? { available: true, port } : { available: false, port: null }
    } catch {
      return { available: false, port: null }
    }
  })

  /** ask_ai 超时「继续/放弃」用户选择（前端对话框点选写入 → 工具挂起等待恢复；见 askAiBus.ts） */
  app.post<{ Body: { answer?: string } }>('/api/browser/ask-ai-answer', async (req, reply) => {
    const answer = req.body?.answer
    if (answer !== 'continue' && answer !== 'abort') {
      return reply.code(400).send({ ok: false, error: 'answer 必须为 continue 或 abort' })
    }
    const consumed = submitAskAiAnswer(answer)
    return { ok: true, consumed }
  })

}
