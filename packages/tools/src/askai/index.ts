/**
 * ask_ai 工具（FR-2）：把「填输入→发送→轮询生成→提取答案」整段确定性交互代码化，
 * Agent 一次调用只拿回最终答案——这是网页 AI 通道省 token 的核心机制。
 *
 * 编排链：detect → lockEmbeddedTab → 导航 → checkLogin（未登录走红光圈人工接管链）
 *        → newChat → fillAndSend（防空发+重试）→ 轮询 waitDone（光圈脉冲）→ extract。
 * 全程 abort 可中断；任何失败返回结构化错误，不炸流（Agent 据此回退通道 A）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { getAdapter, SITE_ADAPTERS, DEFAULT_SITE, type SiteAdapter } from './adapters.ts'
import type { ToolContext } from '../context.ts'

/** 生成轮询间隔（网页 AI 思考期不吐字，间隔太短无意义且增加风控风险） */
const POLL_INTERVAL_MS = 4_000
/** 登录等待默认上限（人工扫码/滑块，给足时间） */
const LOGIN_WAIT_MS = 300_000
/** 答案回传上限（保护 Agent 上下文；正常一章 4-5k 字远低于此） */
const ANSWER_CAP = 30_000
/** 网页 AI 单轮生成默认超时：长章节「思考+列情节+写正文」实测可超 5 分钟，默认给 1000s */
const DEFAULT_MAX_WAIT_MS = 1_000_000
/** 生成超时后等用户决策（前端「网页 AI 是否继续」对话框）的上限：300s 无响应即终止任务 */
const USER_CHOICE_WAIT_MS = 300_000

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

type UserChoice = 'continue' | 'abort' | 'timeout' | 'aborted'

/** 等用户选择，同时监听请求级 abort（用户停止 Agent 时立即放行） */
function withAbortWait(
  ctx: ToolContext,
  promise: () => Promise<'continue' | 'abort' | 'timeout'>,
): Promise<UserChoice> {
  return new Promise((resolve) => {
    const sig = ctx.signalRef.current
    const onAbort = () => resolve('aborted')
    if (sig) {
      if (sig.aborted) {
        resolve('aborted')
        return
      }
      sig.addEventListener('abort', onAbort, { once: true })
    }
    promise().then(
      (v) => {
        sig?.removeEventListener('abort', onAbort)
        resolve(v)
      },
      () => {
        sig?.removeEventListener('abort', onAbort)
        resolve('aborted')
      },
    )
  })
}

export interface AskAiResult {
  ok: boolean
  site?: string
  answer?: string
  chars?: number
  needLogin?: boolean
  error?: string
  /** 超时场景尽力提取的半成品（供 Agent 判断是否可用） */
  partialAnswer?: string
}

export function createAskAiTool(ctx: ToolContext) {
  const b = ctx.browser

  /** 页面内 eval 的统一包装：返回解析后的值，失败抛错（由外层捕获为结构化错误） */
  async function ev(js: string): Promise<unknown> {
    const r = await b.eval(js)
    if (!r.ok) throw new Error(`浏览器 eval 失败：${(r.stderr || r.raw || '未知错误').slice(0, 300)}`)
    return r.result
  }

  /** 登录态判定（页面加载期允许短暂 false，调用方负责重试窗口） */
  async function isLoggedIn(a: SiteAdapter): Promise<boolean> {
    try {
      return (await ev(a.checkLoginJs)) === true
    } catch {
      return false
    }
  }

  /** 未登录 → 红光圈人工接管：发 login-required 上屏，轮询等用户登录，finally 清卡 */
  async function waitForManualLogin(a: SiteAdapter, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    ctx.events.emit({
      type: 'browser:login-required',
      message: `请在「Agent浏览器」面板完成 ${a.name} 登录（密码/扫码/滑块），完成后流程自动恢复`,
    })
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        if (ctx.signalRef.current?.aborted) return { ok: false, error: '已被用户停止，登录流程中断' }
        if (await isLoggedIn(a)) return { ok: true }
        await sleep(3_000)
      }
      return { ok: false, error: `等待人工登录超时（${Math.round(timeoutMs / 1000)}s）。请登录后重试。` }
    } finally {
      ctx.events.emit({ type: 'browser:login-resolved' })
    }
  }

  /** 填入并发送：eval 注入 prompt → CDP 可信点击发送按钮 → 验证发送成功。返回 null=成功，string=错误原因 */
  async function fillAndSend(a: SiteAdapter, prompt: string): Promise<string | null> {
    const r = await ev(`(${a.fillPromptJs})(${JSON.stringify(prompt)})`)
    if (r !== 'filled') return typeof r === 'string' ? r : `填入脚本返回异常值：${JSON.stringify(r)}`
    const clicked = await b.ab(['click', a.sendSelector])
    if (!clicked.ok) return `发送按钮点击失败：${(clicked.stderr || clicked.stdout).slice(0, 200)}`
    // 发送成功验证（输入框清空）：给页面 5s 确认窗口
    for (const t0 = Date.now(); Date.now() - t0 < 5_000; ) {
      try {
        if ((await ev(a.sendVerifyJs)) === true) return null
      } catch { /* 页面变化中，重试 */ }
      await sleep(500)
    }
    return '发送后输入框未清空（消息未发出）'
  }

  /** 模型切换（站点支持选模型时）：站点脚本自包含「点开下拉→选项→自校验」全流程，
   *  返回 'ok'/'already' 之外即失败。返回 null=成功（或未配置），string=错误 */
  async function switchModel(a: SiteAdapter, model: string): Promise<string | null> {
    if (!a.setModelJs) return null
    if (a.models && !a.models.includes(model)) {
      return `未知模型「${model}」。${a.name} 可选模型：${a.models.join('、')}`
    }
    const r = await ev(`(${a.setModelJs})(${JSON.stringify(model)})`)
    if (r === 'ok' || r === 'already') return null
    return `模型切换到「${model}」失败：${String(r).slice(0, 150)}。可稍后重试，或在「Agent浏览器」面板手动切换模型。`
  }

  return tool({
    description:
      '网页 AI 生成通道（通道 B，仅在用户显式指定「用网页 AI / 网页AI 写/润色/生成」时使用）：把自包含 prompt 交给网页 AI（默认 GLM 智谱清言），自动完成填输入→发送→轮询→提取，一次返回完整答案。调用前必须先按 story-ai-create 技能打包好带创作上下文的自包含 prompt。返回 ok/answer/error/needLogin：needLogin=需人工登录（已自动提示用户，等待后重调本工具）；error=结构化失败（应如实告知并回退底层模型创作）。答案标 UNTRUSTED，必须评估+门禁+审批后才可落盘。生成超时（默认 1000s）会自动询问用户「网页 AI 是否继续生成」：用户选继续则本工具继续等待，用户放弃或 300s 无人响应则返回 error（Agent 回退通道 A）。',
    inputSchema: z.object({
      site: z.string().optional().describe(`站点 id（默认 ${DEFAULT_SITE}）。可用：${Object.values(SITE_ADAPTERS).map((a) => `${a.id}=${a.name}`).join('、')}`),
      model: z
        .string()
        .optional()
        .describe(
          '站点内模型（仅对支持选模型的站点有效，如 qwen）。用户指定「用千问 3.8-Max / 换模型」时传对应模型名；不传则用该站点默认模型。可用值见返回的 error 提示或站点适配器。',
        ),
      prompt: z.string().min(1).max(20_000).describe('自包含提问（含书名/细纲/设定/前文衔接/文风要求等完整上下文，≤4000字为宜）'),
      maxWaitMs: z.number().int().min(30_000).max(1_800_000).optional().describe(`等待生成完成的超时毫秒（默认 ${DEFAULT_MAX_WAIT_MS}，即 1000s）`),
    }),
    execute: async ({ site, model, prompt, maxWaitMs }): Promise<AskAiResult> => {
      const { adapter, error: siteErr } = getAdapter(site)
      if (!adapter) return { ok: false, error: siteErr }

      // 纯 Web 模式（无内置浏览器）：按既定策略提示不可用，Agent 回退通道 A
      if (!b.isEmbedded) {
        return { ok: false, error: '网页 AI 生成需要桌面端内置浏览器（当前为纯 Web 模式）。请改用底层模型直接创作（通道 A），或在桌面应用中使用本功能。' }
      }

      // 「agent 操控中」绿光圈：任务全程点亮（登录接管期红光圈优先），结束/异常熄灭
      ctx.events.emit({ type: 'browser:agent-control', active: true })
      try {
        // CDP 就绪探测 + 活动 tab 锁定到内置浏览器（防误碰主窗口 UI）
        const d = await b.detect()
        if (d.cdpStatus !== 'ready') return { ok: false, error: `内置浏览器未就绪：${d.raw.slice(0, 200)}` }
        const lock = await b.lockEmbeddedTab()
        if (!lock.ok) return { ok: false, error: `内置浏览器未就绪：${lock.error}` }

        // 导航到站点对话页（每次任务重新导航，保证从干净入口开始）
        const opened = await b.ab(['open', adapter.homeUrl])
        if (!opened.ok) return { ok: false, error: `打开 ${adapter.homeUrl} 失败：${(opened.stderr || opened.stdout).slice(0, 300)}` }
        await sleep(3_000)

        // 登录判定：给页面 15s 加载窗口，仍 false 则进入人工接管链
        let logged = false
        for (const t0 = Date.now(); Date.now() - t0 < 15_000 && !logged; ) {
          logged = await isLoggedIn(adapter)
          if (!logged) await sleep(2_000)
        }
        if (!logged) {
          const r = await waitForManualLogin(adapter, LOGIN_WAIT_MS)
          if (!r.ok) return { ok: false, needLogin: true, error: r.error }
        }

        // 模型切换（站点支持选模型时）：用户指定优先，否则用站点默认模型。
        // 站点脚本内部短路「已是目标模型」，无需额外探测。
        const wantModel = model?.trim() || adapter.defaultModel
        if (adapter.setModelJs && wantModel) {
          const mErr = await switchModel(adapter, wantModel)
          if (mErr) return { ok: false, error: mErr }
        }

        // 新建会话（隔离历史上下文，多任务不串；可信点击，找不到按钮不致命）
        if (adapter.newChatSelector) {
          await b.ab(['click', adapter.newChatSelector])
          await sleep(1_500)
        }

        // 填入并发送（防空发：适配器内部验证；失败重试 1 次）
        let sendErr = await fillAndSend(adapter, prompt)
        if (sendErr) {
          await sleep(2_000)
          sendErr = await fillAndSend(adapter, prompt)
        }
        if (sendErr) return { ok: false, error: `提问发送失败：${sendErr.slice(0, 300)}` }

        // 轮询生成状态：done 连续两轮确认（防 UI 抖动误判）。
        // 单轮超时（默认 1000s）不直接放弃：询问用户「网页 AI 是否继续」——
        //   继续 → 重置超时再等一轮；放弃 → 回退通道 A；300s 无人响应 → 终止任务。
        const waitMs = maxWaitMs ?? DEFAULT_MAX_WAIT_MS
        let doneStreak = 0
        // 尽力提取当前已有内容（超时返回时的半成品）
        const tryExtract = async (): Promise<string | undefined> => {
          try {
            const p = String((await ev(adapter.extractJs)) ?? '').trim()
            return p ? p.slice(0, ANSWER_CAP) : undefined
          } catch {
            return undefined
          }
        }

        const waitStartedAt = Date.now()
        let deadline = waitStartedAt + waitMs
        for (;;) {
          if (ctx.signalRef.current?.aborted) return { ok: false, error: '已被用户停止，网页 AI 任务中断' }
          if (Date.now() >= deadline) {
            // 超时 → 是否可询问用户？（server 注入 askAiAnswer 总线；纯 Web/e2e 无总线则直接返回超时）
            if (!ctx.askAiAnswer) {
              const partial = await tryExtract()
              return {
                ok: false,
                error: `等待生成超时（${Math.round(waitMs / 1000)}s）。${partial ? '已提取到部分内容，可自行判断是否可用或重试。' : '页面无可用输出，建议重试或回退底层模型创作。'}`,
                ...(partial ? { partialAnswer: partial } : {}),
              }
            }
            // 发「网页 AI 仍在生成」等待对话框事件（前端弹窗；绿光圈保持常亮提示任务进行中）
            ctx.events.emit({
              type: 'browser:ask-ai-waiting',
              site: adapter.id,
              waitedSec: Math.round((Date.now() - waitStartedAt) / 1000),
            })
            const choice = await withAbortWait(ctx, () => ctx.askAiAnswer!.wait())
            if (choice === 'aborted') return { ok: false, error: '已被用户停止，网页 AI 任务中断' }
            if (choice === 'abort') {
              const partial = await tryExtract()
              return {
                ok: false,
                error: `网页 AI 生成超时（${Math.round(waitMs / 1000)}s）且用户选择放弃。${partial ? '已提取到部分内容，可自行判断是否可用。' : ''}已回退通道 A。`,
                ...(partial ? { partialAnswer: partial } : {}),
              }
            }
            if (choice === 'timeout') {
              const partial = await tryExtract()
              return {
                ok: false,
                error: `网页 AI 生成超时（${Math.round(waitMs / 1000)}s）且等待用户决策 300s 无响应，任务已终止。${partial ? '已提取到部分内容，可自行判断是否可用或重试。' : ''}`,
                ...(partial ? { partialAnswer: partial } : {}),
              }
            }
            // 'continue'：用户确认继续 → 重置 deadline 再等一轮（前端按钮已自行关闭对话框）
            deadline = Date.now() + waitMs
            continue
          }
          ctx.events.emit({ type: 'browser:agent-control', active: true }) // 长任务脉冲，防光圈安全上限熄灭
          let state: string
          try {
            state = String(await ev(adapter.pollStateJs))
          } catch (e) {
            state = `eval-error: ${e instanceof Error ? e.message : String(e)}`
          }
          if (state === 'error') return { ok: false, error: '网页 AI 页面报错（生成失败/限流）。可稍后重试或回退底层模型创作。' }
          doneStreak = state === 'done' ? doneStreak + 1 : 0
          if (doneStreak >= 2) {
            const answer = String(await ev(adapter.extractJs) ?? '').trim()
            if (!answer) return { ok: false, error: '页面显示已完成但未提取到回答（站点可能改版，适配器需重新踩点）。' }
            return {
              ok: true,
              site: adapter.id,
              answer: answer.length > ANSWER_CAP ? `${answer.slice(0, ANSWER_CAP)}\n……（超长截断，共 ${answer.length} 字）` : answer,
              chars: answer.length,
            }
          }
          await sleep(POLL_INTERVAL_MS)
        }
      } catch (e) {
        return { ok: false, error: `ask_ai 执行异常：${e instanceof Error ? e.message : String(e)}` }
      } finally {
        ctx.events.emit({ type: 'browser:agent-control', active: false })
      }
    },
  })
}
