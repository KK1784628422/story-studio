/** POST /api/chat —— Agent 聊天入口（SSE，UI 消息流） */
import type { FastifyInstance } from 'fastify'
import type { UIMessage } from 'ai'
import { scanBook } from '@story-studio/preview-core'
import { gateKindFor, resolveSandboxPath } from '@story-studio/tools'
import type { ModeId } from '@story-studio/shared'
import { DEFAULT_FANFIC_SEARCH_SITES } from '@story-studio/shared'
import type { AppState } from '../state.ts'
import { readPreferences } from '../env.ts'
import { chatLog } from '../log.ts'
import { appendUsageRecord } from '../usageStats.ts'
import { localTimestamp } from '../log.ts'

interface ChatBody {
  sessionId?: string
  messages: UIMessage[]
  mode?: ModeId
  /** 输入栏选中的 Provider id（设置面板配置项；不传 = 跟随激活的 Provider） */
  providerId?: string
  reasoningEffort?: string
}

/** 升华（提质）支路机器标记：PolishPanel 组装进用户消息，chat.ts 据此识别「作者批准免检」流程 */
export const POLISH_ELEVATE_MARKER = '<!--polish-variant:elevate-->'

/** 图片附件仅本轮注入：落盘时剥离 user 消息的 file part（防 session 文件膨胀/历史重发重传 base64）。
 *  图片只在发送那一轮进入模型上下文，会话历史与后续请求不再携带。 */
function stripTransientImages(m: UIMessage): UIMessage {
  if (m.role !== 'user' || !Array.isArray(m.parts)) return m
  if (!m.parts.some((p) => p.type === 'file')) return m
  return { ...m, parts: m.parts.filter((p) => p.type !== 'file') }
}

export function registerChatRoute(app: FastifyInstance, state: AppState): void {
  app.post<{ Body: ChatBody }>('/api/chat', async (req, reply) => {
    const { sessionId, messages, mode, providerId, reasoningEffort } = req.body ?? ({} as ChatBody)
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages 不能为空' })
    }

    // 解析/创建会话（客户端生成 id，服务端信任并以其创建）
    let session = sessionId ? state.sessions.load(sessionId) : null
    if (!session) session = state.sessions.create(mode ?? 'discuss', '新会话', sessionId)

    const activeSession = session
    const activeMode: ModeId = mode ?? activeSession.meta.mode
    // 运行中模式实时引用：switch_mode 工具经 setMode 更新 → modeRef 传入 runtime，
    // prepareStep 每步据此重算工具集/提示词（同轮即时生效，不再等下一轮请求）
    const liveMode: { current: ModeId } = { current: activeMode }
    state.toolCtx.setMode = (m) => {
      liveMode.current = m
      state.sessions.setMeta(activeSession.meta.id, { mode: m })
    }

    // 请求级中止信号（用户停止 Agent / 客户端断开 → abort → 工具层树杀在跑的脚本子进程）。
    // signalRef 是共享 ToolContext 上的每请求槽：本轮请求开始写入、断开/结束清空。
    const runAbort = new AbortController()
    state.toolCtx.signalRef.current = runAbort.signal
    const onClientClose = () => {
      req.raw.off('close', onClientClose)
      reply.raw.off('close', onClientClose)
      state.toolCtx.signalRef.current = null
      if (runAbort.signal.aborted) return
      state.hub.emit({ type: 'agent:status', phase: 'stopped' })
      chatLog('warn', `[chat] 客户端中止（用户停止/关闭）session=${activeSession.meta.id}——在跑的脚本子进程将被终止`)
      runAbort.abort(new Error('客户端已断开（用户停止/关闭）'))
    }
    req.raw.on('close', onClientClose)
    reply.raw.on('close', onClientClose)

    // 运行时模型解析（优先级：输入栏选中的 Provider > 设置面板激活的 Provider > .env 兜底）。
    // 前端不再发送任何内置默认模型——模型只能来自用户手动配置。
    const settingsData = state.settings.load()
    const chosen =
      (providerId ? settingsData.providers.find((p) => p.id === providerId) : undefined) ??
      settingsData.providers.find((p) => p.id === settingsData.activeProviderId) ??
      null
    const activeProvider = state.settings.getActive(state.env.baseUrl, state.env.apiKey, state.env.modelId)
    const effModelId = chosen?.modelId ?? activeProvider?.modelId ?? state.env.modelId
    const overridesSrc = chosen ?? activeProvider
    // modelOverrides 携带 Provider 高级配置（上下文窗口/输出上限/采样参数），agent-core 按
    //「请求级覆盖 > Provider 配置 > 默认」三级优先消费
    const modelOverrides = overridesSrc
      ? {
          baseUrl: overridesSrc.baseUrl || state.env.baseUrl,
          apiKey: overridesSrc.apiKey || state.env.apiKey,
          displayName: overridesSrc.displayName,
          contextTokens: overridesSrc.contextTokens,
          maxOutputTokens: overridesSrc.maxOutputTokens,
          temperature: overridesSrc.temperature,
          topP: overridesSrc.topP,
          topK: overridesSrc.topK,
          // 免费池 key 清单：agent-core 据此在 429 时自动换 key 轮询重试（不中断对话）
          apiKeys: overridesSrc.apiKeys,
        }
      : undefined
    const freeKeys = overridesSrc?.kind === 'free' && Array.isArray(overridesSrc.apiKeys) ? overridesSrc.apiKeys.length : 0
    chatLog('info', `[chat] 收到请求 session=${activeSession.meta.id} mode=${activeMode} 模型=${effModelId}${overridesSrc ? `（provider:${overridesSrc.name}${chosen ? '/输入栏指定' : '/激活'}${freeKeys >= 2 ? `/免费池×${freeKeys}` : ''}）` : '（.env 兜底）'} 思考=${reasoningEffort ?? 'max(默认)'} 历史=${messages.length} 条`)
    if (mode && mode !== activeSession.meta.mode) {
      state.sessions.setMeta(activeSession.meta.id, { mode })
    }

    // 持久化增量消息（客户端每次发全量；增量 = 超出已存数量的尾部消息）。
    // 等长且末条同 id = 审批响应后客户端原地更新最后一条 assistant（approval-responded）→ 替换存储末条
    const storedCount = activeSession.messages.length
    if (messages.length > storedCount) {
      for (const m of messages.slice(storedCount)) {
        state.sessions.appendUi(activeSession.meta.id, stripTransientImages(m))
      }
    } else if (
      messages.length === storedCount &&
      storedCount > 0 &&
      messages[messages.length - 1]?.id === activeSession.messages[storedCount - 1]?.id
    ) {
      state.sessions.appendOrReplaceUi(activeSession.meta.id, stripTransientImages(messages[messages.length - 1]))
    }
    state.sessions.ensureTitle(activeSession, messages)

    // ---- 作者批准（polish 升华支路）：检测本轮审批已通过的正文写入 → 登记一次性免检 ----
    // 升华支路提示词带机器标记 `<!--polish-variant:elevate-->`（PolishPanel 组装）；
    // 命中判定：末条用户消息含标记 + 消息中存在 approval-responded 且 approved 的 Write/Edit
    // 且目标为 正文/*.md → approveNextWrite(abs)：该次写入免检并落地注册表，
    // 之后指纹命中持续免检、指纹失配（AI 后续改动）自动清标记恢复门禁。
    // 每轮先清 pending：标记只在「检测到审批的同一轮请求」内有效，防跨轮残留误免检。
    state.toolCtx.gate.clearPendingApproval()
    const lastUserText =
      [...messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.parts?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ') ?? ''
    if (lastUserText.includes(POLISH_ELEVATE_MARKER)) {
      for (const m of messages) {
        const parts = (m.parts ?? []) as Array<Record<string, unknown>>
        for (const p of parts) {
          if (p.type !== 'tool-call' || p.state !== 'approval-responded') continue
          if ((p.approval as { approved?: boolean } | undefined)?.approved !== true) continue
          const toolName = p.toolName ?? (p as { tool?: string }).tool
          if (toolName !== 'Write' && toolName !== 'Edit') continue
          const inp = p.input ?? (p as { args?: unknown }).args
          const path = (inp as { path?: string } | undefined)?.path
          if (!path) continue
          try {
            const abs = resolveSandboxPath({ workspace: state.env.workspace, skillDirs: [] }, path, {
              forWrite: true,
              allowMissing: true,
            })
            if (gateKindFor(state.env.workspace, abs) === 'full') {
              state.toolCtx.gate.approveNextWrite(abs)
              chatLog('info', `[chat] 升华审批通过：作者批准免检登记 正文 ${abs}`)
            }
          } catch {
            // 路径非法/越界 → 忽略
          }
        }
      }
    }

    // 目录 digest（先取旧的用于替换消息判定，再写入新的）
    const prevCatalogDigest = activeSession.catalogDigest
    state.sessions.setCatalogDigest(activeSession.meta.id, state.skills.digest())

    // 状态段（每轮重建）
    const book = scanBook(state.env.workspace)
    const status = {
      bookTitle: book.title,
      workspace: state.env.workspace,
      latestChapter: book.latestChapter,
      trackingRevision: book.trackingRevision,
      lastCommittedChapter: book.lastCommittedChapter,
    }

    state.hub.emit({ type: 'agent:status', phase: 'thinking' })

    // ---- token 统计落盘（runKey 幂等 + 中断兜底）----
    // 痛点：此前仅 agent-core onFinish 的最终快照（durationMs>0）落盘——用户中途停止/断开时
    // 最终快照可能永不到来（SDK abort 不回调）或迟到一个 SSE 周期，中途消耗不落账。
    // 方案：每轮生成 runKey；逐步快照缓存；SSE 流关闭（正常/异常/客户端断开均触发 finally）
    // 时若未落过盘，用最后快照兜底补落（durationMs 按当时算）。后台仍在跑的 agent 稍后
    // 产出最终快照时按同一 runKey 覆盖兜底记录（appendUsageRecord upsert），不会双计。
    const runKey = `run-${activeSession.meta.id}-${Date.now().toString(36)}`
    // 任务描述 = 首条用户输入问题（完整文本，统计列表截断展示、悬停看全文；上限 500 字防膨胀）
    const taskPrompt =
      (() => {
        const firstUser = messages.find((m) => m.role === 'user')
        if (!firstUser) return activeSession.meta.title
        const text =
          firstUser.parts
            ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .trim()
            .slice(0, 500) ?? ''
        return text || activeSession.meta.title
      })()
    let usageFlushed = false
    let lastUsageSnap: {
      calls: number
      inputTokens: number
      outputTokens: number
      noCacheTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      capacityTokens: number
    } | null = null
    const flushUsage = (
      snap: NonNullable<typeof lastUsageSnap>,
      durationMs: number,
    ) => {
      if (snap.calls <= 0) return
      appendUsageRecord(
        {
          at: localTimestamp(),
          runId: runKey,
          sessionId: activeSession.meta.id,
          title: taskPrompt,
          mode: activeMode,
          model: effModelId,
          calls: snap.calls,
          inputTokens: snap.inputTokens,
          outputTokens: snap.outputTokens,
          noCacheTokens: snap.noCacheTokens,
          cacheReadTokens: snap.cacheReadTokens,
          cacheWriteTokens: snap.cacheWriteTokens,
          durationMs,
          capacityTokens: snap.capacityTokens,
        },
        { upsertByRunId: true },
      )
      usageFlushed = true
    }

    // 同人模式专属上下文：搜索源清单注入系统提示词（agent-core 仅 fanfic 模式消费）
    const fanficSites = settingsData.fanficSearchSites ?? DEFAULT_FANFIC_SEARCH_SITES
    const modeContext =
      activeMode === 'fanfic' && fanficSites.length > 0
        ? `## 同人搜索源（设置中心「同人」页可配置）
检索原著资料的顺序：先自由 web_search 广撒网，再逐站定向补全——用 web_search 加 site: 限定（如「〈原著名〉 世界观 site:zh.moegirl.org.cn」），或 web_fetch 直接抓站内页面。清单：
${fanficSites.map((s) => `- ${s.name}（site:${s.host}）`).join('\n')}
两轮搜索仍缺的细节如实告知用户，不得编造原著设定；不同来源矛盾时标注来源让用户裁定。`
        : undefined

    let response: Response
    try {
      response = await state.runtime.chatStream({
        mode: activeMode,
        modeRef: liveMode,
        // 会话级稳定 id：opencode 网关 x-opencode-session（同一对话各步请求一致 → 提示词缓存命中）
        sessionId: activeSession.meta.id,
        messages,
        status,
        preferences: readPreferences(state.env.workspace),
        modeContext,
        previousCatalogDigest: prevCatalogDigest,
        ...(modelOverrides ? { modelOverrides: { ...modelOverrides, modelId: effModelId } } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        onStep: ({ step, total }) => state.hub.emit({ type: 'agent:step', step, total }),
        // token 消耗快照（每步+流结束）：状态栏容量进度条 / 聊天区统计条 / 缓存命中率
        onUsage: (snap) => {
          state.hub.emit({ type: 'agent:usage', sessionId: activeSession.meta.id, ...snap })
          if (snap.durationMs > 0) {
            // 最终快照（agent-core onFinish）→ 落盘（runKey upsert，覆盖 SSE 兜底的中间值）
            flushUsage(
              {
                calls: snap.calls,
                inputTokens: snap.inputTokens,
                outputTokens: snap.outputTokens,
                noCacheTokens: snap.noCacheTokens,
                cacheReadTokens: snap.cacheReadTokens,
                cacheWriteTokens: snap.cacheWriteTokens,
                capacityTokens: snap.capacity.tokens,
              },
              snap.durationMs,
            )
          } else if (snap.calls > 0) {
            // 逐步快照缓存：供 SSE 关闭时兜底补落（用户中途停止场景）
            lastUsageSnap = {
              calls: snap.calls,
              inputTokens: snap.inputTokens,
              outputTokens: snap.outputTokens,
              noCacheTokens: snap.noCacheTokens,
              cacheReadTokens: snap.cacheReadTokens,
              cacheWriteTokens: snap.cacheWriteTokens,
              capacityTokens: snap.capacity.tokens,
            }
          }
        },
        onFinish: ({ responseMessage }) => {
          // 审批续跑时 responseMessage 与已存末条同 id（continuation）：替换而非重复追加
          try {
            state.sessions.appendOrReplaceUi(activeSession.meta.id, responseMessage)
            state.hub.emit({ type: 'agent:status', phase: 'idle' })
            chatLog('info', `[chat] 流正常结束 session=${activeSession.meta.id}`)
          } catch (err) {
            // onFinish 在流结束后异步触发，路由 try 已退出、reply 已 send，抛错即 unhandled rejection → 进程崩溃
            chatLog('error', `[chat] onFinish 持久化失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
            try {
              state.hub.emit({ type: 'agent:status', phase: 'idle' })
            } catch {
              /* 忽略 */
            }
          }
        },
      })
    } catch (err) {
      state.hub.emit({ type: 'agent:status', phase: 'idle' })
      console.error('[chat] agent 启动失败:', err)
      chatLog('error', `[chat] agent 启动失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      return reply.code(502).send({
        error: `Agent 启动失败：${err instanceof Error ? err.message : String(err)}（检查 .env 的端点/模型/key 配置）`,
      })
    }

    // SSE 心跳：长工具（如 review_agents 多视角并行，可达数分钟）执行期间流静默，
    // Node undici fetch 默认 bodyTimeout=300s 会掐断空闲连接 → 每 15s 注入 SSE comment 保活。
    const upstream = response.body
    if (!upstream) {
      state.hub.emit({ type: 'agent:status', phase: 'idle' })
      return reply.code(502).send({ error: '模型响应缺少流式 body' })
    }
    const startedAt = Date.now()
    const encoder = new TextEncoder()
    // reader 提升到外层：cancel() 必须经 reader.cancel() 释放——upstream 已被 reader 锁定，
    // 直接 upstream.cancel() 会抛 ERR_INVALID_STATE（ReadableStream is locked），
    // 异常穿透 fastify 响应关闭钩子 → 未捕获 → 整个进程崩溃（vite 端 ECONNREFUSED 连锁）。
    // cancel 与 start 竞态：cancel 先于 getReader 触发时，靠 cancelled 标志 + start 立即放弃上游收尾。
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let upstreamCancelled = false
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const heartbeat = new ReadableStream<Uint8Array>({
      async start(controller) {
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            /* 流已关闭 */
          }
        }, 15_000)
        let reader: ReadableStreamDefaultReader<Uint8Array>
        try {
          reader = (upstreamReader = upstream.getReader())
        } catch {
          // 上游 body 异常（已锁定等）：清心跳并关闭下游，避免异常穿透 start
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          try {
            controller.close()
          } catch {
            /* 已关闭 */
          }
          return
        }
        if (upstreamCancelled) {
          // cancel 先于 start 到达：放弃上游，防止向已取消的下游 enqueue
          await reader.cancel().catch(() => {})
          return
        }
        // 断流检测：正常结束的 OpenAI 兼容流必含 finish_reason=stop/length（DeepSeek 官方）
        // 或 [DONE] 标记（多数网关）。都没有 = 上游中途断开（网关掐流/网络中断）——
        // undici 对"优雅断开"不抛错（read 返回 done），SDK 视为正常完成 → 前端假成功。
        // 实测会话 1ee95768：思考 408 字在半句被切、输出仅 1.3K token、无 length 截断。
        const dec = new TextDecoder()
        let sawFinish = false
        let sawDone = false
        let received = 0
        let lastChunkAt = startedAt
        let readErr: unknown = null
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            lastChunkAt = Date.now()
            // 轻量扫描（诊断用途，不做完整 JSON 解析；正则容空格）
            if (!sawFinish || !sawDone) {
              const t = dec.decode(value, { stream: true })
              if (!sawFinish && /"finish_reason"\s*:\s*"(?:stop|length)"/.test(t)) sawFinish = true
              if (!sawDone && t.includes('[DONE]')) sawDone = true
            }
            controller.enqueue(value)
          }
        } catch (e) {
          readErr = e // read() reject：异常断流（连接 RST 等）；下面统一按断流收尾
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          const gapSec = ((Date.now() - lastChunkAt) / 1000).toFixed(1)
          if (!sawFinish && !sawDone && !upstreamCancelled) {
            chatLog(
              'warn',
              `[chat] 上游流中断 session=${activeSession.meta.id} 已收=${received}B 最后chunk距今=${gapSec}s ` +
                `readError=${readErr ? String(readErr instanceof Error ? readErr.message : readErr).slice(0, 100) : '无（优雅断开）'}——注入 error 事件供前端提示`,
            )
            // 注入 UIMessage error chunk：前端 useChat onError 触发 → 明确报错（而非假成功定格）
            try {
              controller.enqueue(
                encoder.encode(
                  `data: {"type":"error","errorText":"模型连接中断——上游流被切断（非正常结束，已收 ${received} 字节）。已产出的内容与上下文完整保留，回复「继续」可从此处续跑；若反复出现建议更换 Provider 或降低思考档位。"}\n\n`,
                ),
              )
            } catch {
              /* 下游已关闭 */
            }
          }
          chatLog('info', `[chat] SSE 流关闭 session=${activeSession.meta.id} 时长=${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
          // 统计兜底：流关闭（正常结束/异常/客户端断开）但最终快照未落盘（用户中途停止、
          // SDK abort 未回调 onFinish）→ 用最后逐步快照补落本轮已发生的消耗；
          // 后台 agent 若稍后正常收尾，最终快照按同一 runKey 覆盖本条（upsert），不会双计
          if (!usageFlushed && lastUsageSnap && lastUsageSnap.calls > 0) {
            flushUsage(lastUsageSnap, Date.now() - startedAt)
          }
          try {
            controller.close()
          } catch {
            /* 已关闭 */
          }
        }
      },
      cancel() {
        // pending 的 reader.read() 会被取消而立即 resolve（done=true），start 的循环随之退出
        upstreamCancelled = true
        void upstreamReader?.cancel().catch(() => {})
      },
    })

    reply.header('x-session-id', activeSession.meta.id)
    reply.header('content-type', response.headers.get('content-type') ?? 'text/event-stream')
    reply.header('cache-control', 'no-cache')
    reply.header('x-accel-buffering', 'no')
    return reply.send(heartbeat)
  })
}
