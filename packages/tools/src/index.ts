/**
 * 工具集总装：createTools(ctx) 返回全部工具（模式白名单由 agent-core 过滤）。
 * 命名对齐 Claude Code（Read/Write/Edit/Glob/Grep/Bash）——SKILL.md 原文指涉即刻成立。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODES, type ModeId } from '@story-studio/shared'
import { createFsTools } from './fs.ts'
import { createTrackingTools } from './tracking.ts'
import { BashExecutor } from './bash.ts'
import { GateEngine } from './gate.ts'
import { EdgeTtsService } from './tts.ts'
import { bingSearch, duckDuckGoSearch, webSearch } from './search.ts'
import { webFetch } from './webfetch.ts'
import { BrowserCdpClient } from './browser.ts'
import { createAskAiTool } from './askai/index.ts'
import { createWebAiDrawTool } from './webaidraw/index.ts'
import type { ToolContext, ToolContextDeps } from './context.ts'
export { BashExecutor, detectPython } from './bash.ts'
export { GateEngine, gateKindFor, chapterNumberFromPath } from './gate.ts'
export { EdgeTtsService, TtsError, TTS_VOICES } from './tts.ts'
export { SandboxError, resolveSandboxPath, toDisplayPath, isProtectedDerivedPath } from './sandbox.ts'
export { bingSearch, duckDuckGoSearch, webSearch, parseBingHtml, parseDdgHtml, type SearchHit } from './search.ts'
export { webFetch, htmlToText, type WebFetchResult } from './webfetch.ts'
export { BrowserCdpClient, type BrowserCdpDeps } from './browser.ts'
export { SITE_ADAPTERS, DEFAULT_SITE, getAdapter, type SiteAdapter } from './askai/adapters.ts'
export type { AskAiResult } from './askai/index.ts'
export type { ToolContext, ToolContextDeps, ReviewerRequest, ReviewerResult } from './context.ts'

export function createToolContext(deps: ToolContextDeps): ToolContext {
  /** 请求级中止信号槽（chat.ts 每轮写入；工具执行时读取最新值） */
  const signalRef: { current: AbortSignal | null } = { current: null }
  const bash = new BashExecutor({
    workspace: deps.workspace,
    sandbox: { workspace: deps.workspace, skillDirs: deps.skills.roots },
    skills: deps.skills,
    pythonCommand: deps.pythonCommand,
    currentSignal: () => signalRef.current,
  })
  const gate = new GateEngine({
    workspace: deps.workspace,
    skills: deps.skills,
    bash,
    events: deps.events,
  })
  const tts = new EdgeTtsService(join(deps.workspace, '.story-studio', 'tts-cache'))
  const browser = new BrowserCdpClient({
    agentBrowserJs: deps.agentBrowserJs ?? '',
    skillsRoot: deps.skills.root,
    currentSignal: () => signalRef.current,
  })
  const ctx: ToolContext = {
    workspace: deps.workspace,
    sandbox: { workspace: deps.workspace, skillDirs: deps.skills.roots },
    skills: deps.skills,
    bash,
    gate,
    tts,
    browser,
    events: deps.events,
    loadedSkillDirs: [],
    signalRef,
    setMode: deps.setMode,
    spawnReviewers: deps.spawnReviewers,
  }
  bash.preferredSkillDirs = () => ctx.loadedSkillDirs
  return ctx
}

/** 包装 execute：异常捕获为模型可读的 { error } 输出（工具失败不炸流，模型可自行纠正），并落服务端日志 */
function withErrorCapture(name: string, tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {}
  for (const [key, t] of Object.entries(tools)) {
    const toolDef = t as { execute?: (input: never, options: never) => Promise<unknown> }
    if (!toolDef.execute) {
      wrapped[key] = t
      continue
    }
    const orig = toolDef.execute
    wrapped[key] = {
      ...t,
      execute: async (input: never, options: never) => {
        try {
          return await orig(input, options)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[tool:${name}.${key}] ${msg}`)
          return { error: msg }
        }
      },
    } as (typeof tools)[typeof key]
  }
  return wrapped
}

export function createTools(ctx: ToolContext): ToolSet {
  const fsTools = createFsTools(ctx)
  const trackingTools = createTrackingTools(ctx)

  // 扫榜采集脚本（驱动内置浏览器）在 Bash 命令中的识别正则——用于「agent 操控中」光圈脉冲
  const SCAN_SCRIPT_RE =
    /(fanqie-rank-scraper|qidian-rank-scraper|qimao-rank-scraper|jjwxc-rank-scraper|ciweimao-rank-scraper|dz-browse-scraper|heiyan-booklist-scraper)\.js/

  const bashTool = tool({
    description:
      '白名单命令执行：仅允许 node [--env-file=<文件>] <脚本> / python <脚本> / py -3 <脚本>，脚本必须位于技能 scripts/ 内（写 scripts/check-ai-patterns.js 这类相对形式会自动解析到技能目录）。cwd 默认书工作区根。用于运行 oh-story 质检脚本、tracking_commit.py、storyctl.py、扫榜采集脚本。需要注入环境变量时用 node --env-file=<工作区内文件>（先用 Write 创建，如 .story-studio/env.xxx 内容 KEY=VALUE）。返回 exitCode/stdout/stderr（UTF-8）。',
    inputSchema: z.object({
      command: z.string().describe('命令行（如 node scripts/check-ai-patterns.js --check --fail-on=blocking 正文/第010章_*.md）'),
      cwd: z.string().optional().describe('工作目录（默认书工作区根）'),
      timeout: z.number().int().min(1000).max(300000).optional().describe('超时毫秒（默认 60000）'),
    }),
    execute: async ({ command, cwd, timeout }) => {
      // 扫榜采集脚本在驱动内置浏览器——推送「agent 操控中」脉冲（前端光圈按 true/false 生命周期点亮/宽限熄灭）
      const drivingBrowser = SCAN_SCRIPT_RE.test(command)
      if (drivingBrowser) ctx.events.emit({ type: 'browser:agent-control', active: true })
      try {
        const r = await ctx.bash.execute(command, cwd, timeout)
        return {
          command: r.command,
          cwd: r.cwd,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          timedOut: r.timedOut ?? false,
          aborted: r.aborted ?? false,
          hint:
            r.exitCode === 0
              ? undefined
              : 'exit 2=参数/IO 错误；exit 1=检测有命中（blocking）。质检脚本的判定以 exitCode 为准，不要凭感觉汇报。',
        }
      } finally {
        if (drivingBrowser) ctx.events.emit({ type: 'browser:agent-control', active: false })
      }
    },
  })

  const loadSkillTool = tool({
    description:
      '加载技能（L2 披露）：返回该技能 SKILL.md 全文与 references/scripts 资源清单。任务命中技能时必须先加载再按其流程执行。',
    inputSchema: z.object({
      name: z.string().describe('技能名（见会话开头的技能目录）'),
    }),
    execute: async ({ name }) => {
      const content = ctx.skills.load(name)
      ctx.loadedSkillDirs = [content.dir, ...ctx.loadedSkillDirs.filter((d) => d !== content.dir)].slice(0, 6)
      return { name, dir: content.dir, content: ctx.skills.render(content) }
    },
  })

  const switchModeTool = tool({
    description:
      '切换工作模式（8 种）。检测到任务性质变化时主动切换：讨论→创作→导入→优化→市场→审稿→同人。切换即时生效：同轮后续步骤即按新模式的工具集与提示词运行。预览模式是纯前端面板，无需切换。',
    inputSchema: z.object({
      mode: z.enum(MODES.map((m) => m.id) as [ModeId, ...ModeId[]]),
      reason: z.string().optional().describe('切换原因（展示给用户）'),
    }),
    execute: async ({ mode, reason }) => {
      ctx.setMode(mode)
      ctx.events.emit({ type: 'mode:switched', mode, reason })
      return `已切换到 ${mode} 模式${reason ? `（${reason}）` : ''}。切换即时生效：本运行从下一步起即按新模式的工具集与提示词执行，可直接调用此前不可用的工具。`
    },
  })

  const ttsPreviewTool = tool({
    description:
      'TTS 听感预览：合成一段中文文本（≤600 字）并返回可直接播放的 URL。用于"听感校对"场景；完整听书走预览面板（不消耗 Agent）。',
    inputSchema: z.object({
      text: z.string().min(1).max(600).describe('要朗读的文本'),
      voice: z.string().optional().describe('音色（默认 zh-CN-XiaoxiaoNeural）'),
    }),
    execute: async ({ text, voice }) => {
      const buf = await ctx.tts.synthesize(voice, undefined, undefined, text)
      const params = new URLSearchParams({ text })
      if (voice) params.set('voice', voice)
      return { url: `/api/tts?${params.toString()}`, bytes: buf.length, voice: voice ?? 'zh-CN-XiaoxiaoNeural' }
    },
  })

  const webSearchTool = tool({
    description:
      '联网搜索（Bing 优先、DuckDuckGo 降级，尽力而为）：返回标题/URL/摘要列表。用于讨论模式查证资料、市场模式辅助调研。今天是几号见系统提示词「当前状态-今天」；查询包含时间语义（火/流行/排行/行情等）时必须把时效词写进 query（如 2026、今年、本月、最近 30 天、最新），禁止沿用旧年份，防止拿到的资料滞后。结果可能为空或失败（反爬/网络），失败时如实告知用户，不要编造结果。',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('搜索关键词'),
    }),
    execute: async ({ query }) => {
      try {
        const { hits, engine, errors } = await webSearch(query)
        return { query, engine, count: hits.length, results: hits, ...(errors.length > 0 ? { notes: errors } : {}) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { query, count: 0, results: [], error: `搜索失败：${msg}` }
      }
    },
  })

  const askQuestionsTool = tool({
    description:
      '向用户提出需要拍板/确认/选择的问题（以问答表单呈现，用户可逐题作答或跳过）。适合开书决策点、方案取舍、设定确认、多选一等必须用户明确回复的场景；一次可提 1-10 个问题，每个问题保持独立、简短，可单独作答。调用后请结束本轮回复，等待用户在表单中作答（跳过的题目会标注「跳过」）。',
    inputSchema: z.object({
      title: z.string().min(1).max(60).optional().describe('表单标题，如「需要你拍板的 5 个决策点」'),
      questions: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(10)
        .describe('问题列表；每题一行，尽量简短（含必要的选项说明，如「(a)/(b)」）'),
    }),
    execute: async ({ title, questions }) => ({
      ok: true,
      title: title ?? 'Agent 向你提问',
      count: questions.length,
      note: '问题已进入问答表单。请就此结束本轮回复，等待用户在表单中作答（跳过的题目会被标为「（跳过）」）。',
    }),
  })

  const askConfirmTool = tool({
    description:
      '向用户弹一个**单题确认表单**（是/否/选项类必须用户明确点选的场景），如「用户请手动登录！已登录/取消」。与 ask_questions（多题问答）不同：只有一个问题、用户直接点选作答。调用后请结束本轮回复，等待用户在表单中确认；用户的选择会作为下一条消息返回。',
    inputSchema: z.object({
      title: z.string().min(1).max(60).optional().describe('表单标题，如「网页 AI 需要登录」'),
      question: z.string().min(1).max(300).describe('确认问题（含选项说明，如「请在真实浏览器完成登录后选择：已登录 / 取消」）'),
    }),
    execute: async ({ title, question }) => ({
      ok: true,
      title: title ?? '需要你确认',
      count: 1,
      note: '确认表单已呈现。请就此结束本轮回复，等待用户点选确认。',
      question,
    }),
  })

  const saveReportTool = tool({
    description:
      '审稿/扫榜报告落盘（审稿模式唯一写通道）：只允许写 .story-studio/reports/ 目录。审稿铁律——不改正文/大纲/设定/追踪，报告只能通过本工具保存。',
    inputSchema: z.object({
      title: z.string().min(1).max(80).describe('报告标题（用作文件名，如 审稿报告_第7-9章）'),
      markdown: z.string().min(1).describe('报告全文（Markdown）'),
    }),
    execute: async ({ title, markdown }) => {
      // 文件名安全化：去路径分隔符与非法字符
      const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || '报告'
      const dir = join(ctx.workspace, '.story-studio', 'reports')
      mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().slice(0, 16).replaceAll(/[T:]/g, '-')
      const file = join(dir, `${safe}_${ts}.md`)
      writeFileSync(file, markdown, 'utf8')
      return { ok: true, path: `.story-studio/reports/${safe}_${ts}.md`, bytes: markdown.length }
    },
  })

  const webFetchTool = tool({
    description:
      '抓取网页正文（匿名 HTTP，无 key）：返回 URL/状态码/净化后的可读文本（HTML 自动去脚本样式，≤200KB 截断）。用于讨论模式查证资料（配合 web_search 深入阅读结果页）、市场模式拆文。非 2xx 也是有效结果（状态码在返回里）。',
    inputSchema: z.object({
      url: z.string().url().describe('要抓取的 http/https URL'),
    }),
    execute: async ({ url }) => {
      try {
        return await webFetch(url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { url, error: `抓取失败：${msg}` }
      }
    },
  })

  const browserCdpTool = tool({
    description:
      'CDP 控制浏览器（市场扫榜/需要 JS 渲染的站点用）。桌面应用下自动连接内置浏览器（应用内嵌 BrowserView，绝不动系统浏览器，无需 setup，在线即采）；纯浏览器模式才 setup 启动 9222 调试 Chrome（⚠️ 会 kill 常规 Chrome，必须先征得用户明确同意）。动作：status（探测，无副作用）/ setup / open / wait / eval / snapshot / click / type / scroll / login（等待人工登录：检测到登录页时调用，js 传登录成功判定表达式，返回 true 即视为完成，面板会显示交接卡片）。首次使用先 status。',
    inputSchema: z.object({
      action: z.enum(['status', 'setup', 'open', 'wait', 'eval', 'snapshot', 'click', 'type', 'scroll', 'login']).describe('要执行的动作'),
      url: z.string().url().optional().describe('open：目标 URL'),
      js: z.string().optional().describe('eval：浏览器内执行的 JS 表达式（走 base64 通道，无需顾虑转义）；login：登录成功判定表达式，返回 true 视为登录完成'),
      ms: z.number().int().min(100).max(30000).optional().describe('wait：等待毫秒数'),
      selector: z.string().optional().describe('click/type：CSS 选择器或 snapshot 里的 @eN 元素引用'),
      text: z.string().optional().describe('type：要输入的文本'),
      times: z.number().int().min(1).max(30).optional().describe('scroll：滚动次数（每次间隔 1s）'),
      interactiveOnly: z.boolean().optional().describe('snapshot：true=仅交互元素（-i）'),
      message: z.string().max(200).optional().describe('login：展示给用户的交接提示，如「请在弹出的 Chrome 窗口完成番茄登录（手机扫码）」'),
      timeoutMs: z.number().int().min(10000).max(600000).optional().describe('login：等待人工登录的超时毫秒（默认 120000）'),
    }),
    execute: async (input) => {
      const b = ctx.browser
      // 「agent 操控中」光圈脉冲：status/setup 属探测/安装不算操控，其余动作都在驱动浏览器
      const driving = input.action !== 'status' && input.action !== 'setup'
      if (driving) ctx.events.emit({ type: 'browser:agent-control', active: true })
      try {
        // 桌面模式：操作类动作（非 status/setup）先把活动 tab 锁定到内置浏览器，防误碰主窗口 UI
        if (input.action !== 'status' && input.action !== 'setup' && b.isEmbedded) {
          const lock = await b.lockEmbeddedTab()
          if (!lock.ok) return { error: `内置浏览器未就绪：${lock.error}` }
        }
      switch (input.action) {
        case 'status': {
          const d = await b.detect()
          return { action: 'status', port: b.port, agentBrowserInstalled: b.available, ...d }
        }
        case 'setup': {
          const r = await b.setup()
          return { action: 'setup', ok: r.ok, exitCode: r.exitCode, output: (r.stdout || r.stderr).slice(0, 4000) }
        }
        case 'open': {
          if (!input.url) return { error: 'open 需要 url' }
          const r = await b.ab(['open', input.url])
          return { action: 'open', ok: r.ok, exitCode: r.exitCode, output: (r.stdout || r.stderr).slice(0, 2000) }
        }
        case 'wait': {
          const r = await b.ab(['wait', String(input.ms ?? 3000)])
          return { action: 'wait', ok: r.ok, output: r.stdout.slice(0, 500) }
        }
        case 'eval': {
          if (!input.js) return { error: 'eval 需要 js' }
          const r = await b.eval(input.js)
          return { action: 'eval', ok: r.ok, result: r.result ?? r.raw.slice(0, 8000), stderr: r.stderr || undefined }
        }
        case 'snapshot': {
          const r = await b.ab(['snapshot', ...(input.interactiveOnly ? ['-i'] : [])])
          return { action: 'snapshot', ok: r.ok, output: r.stdout.slice(0, 12000) }
        }
        case 'click': {
          if (!input.selector) return { error: 'click 需要 selector' }
          const r = await b.ab(['click', input.selector])
          return { action: 'click', ok: r.ok, output: (r.stdout || r.stderr).slice(0, 2000) }
        }
        case 'type': {
          if (!input.selector || input.text === undefined) return { error: 'type 需要 selector 与 text' }
          const r = await b.ab(['type', input.selector, input.text])
          return { action: 'type', ok: r.ok, output: (r.stdout || r.stderr).slice(0, 2000) }
        }
        case 'scroll': {
          const times = input.times ?? 3
          const results: string[] = []
          for (let i = 0; i < times; i++) {
            const r = await b.ab(['eval', 'window.scrollBy(0, window.innerHeight)'])
            if (!r.ok) results.push(`第${i + 1}次失败: ${r.stderr.slice(0, 200)}`)
            await new Promise((res) => setTimeout(res, 1000))
          }
          return { action: 'scroll', ok: results.length === 0, issues: results.length ? results : undefined }
        }
        case 'login': {
          if (!input.js) return { error: 'login 需要 js（登录成功判定表达式，返回 true 视为登录完成）' }
          const timeoutMs = input.timeoutMs ?? 120_000
          const message = input.message ?? (b.isEmbedded
            ? '请在「Agent浏览器」面板画面里完成登录（密码/扫码/滑块），完成后流程自动恢复'
            : '请在弹出的调试 Chrome 窗口完成登录，完成后流程自动恢复')
          // 交接卡片：login-required 上屏；login-resolved 清卡（无论成功/超时都由 finally 兜底）
          ctx.events.emit({ type: 'browser:login-required', message })
          const deadline = Date.now() + timeoutMs
          let lastErr = ''
          try {
            while (Date.now() < deadline) {
              // 用户停止 Agent：立即中断登录轮询
              if (ctx.signalRef.current?.aborted) {
                return { action: 'login', ok: false, error: '已被用户停止，登录流程中断' }
              }
              const r = await b.eval(input.js)
              if (r.ok) {
                if (r.result === true) {
                  return { action: 'login', ok: true, resolved: true, waitedMs: timeoutMs - (deadline - Date.now()) }
                }
                if (r.result !== false) lastErr = `判定表达式返回 ${JSON.stringify(r.result)}（应为 true/false）`
              } else {
                lastErr = r.stderr || r.raw || 'eval 失败'
              }
              await new Promise((res) => setTimeout(res, 3000))
            }
          } finally {
            ctx.events.emit({ type: 'browser:login-resolved' })
          }
          return {
            action: 'login',
            ok: false,
            error: `等待人工登录超时（${Math.round(timeoutMs / 1000)}s）${lastErr ? `；最后判定：${lastErr.slice(0, 200)}` : ''}。请告知用户登录状态后重试。`,
          }
        }
      }
      } finally {
        if (driving) ctx.events.emit({ type: 'browser:agent-control', active: false })
      }
    },
  })

  const askAiTool = createAskAiTool(ctx)
  const webAiDrawTool = createWebAiDrawTool(ctx)

  const reviewAgentsTool = tool({
    description:
      '多视角并行审稿（story-review full 模式）：为每个视角 spawn 一个独立只读子 Agent 并行审查，返回各视角的审查报告。默认 4 视角（剧情逻辑/文风文笔/读者体验/商业潜力），可自定义。主流程：先自己做确定性预检，再调用本工具并行深审，最后汇总各视角为 S1-S4 分级报告（汇总报告用 save_report 落盘）。',
    inputSchema: z.object({
      instruction: z.string().min(1).describe('给每个审查视角的统一指令：审查范围（章节）、本书背景、输出要求（Findings 带 location/evidence/issue/fix）'),
      perspectives: z.array(z.string().min(1)).min(1).max(6).optional().describe('审查视角列表（默认 剧情逻辑/文风文笔/读者体验/商业潜力）'),
    }),
    execute: async ({ instruction, perspectives }) => {
      if (!ctx.spawnReviewers) {
        return { error: '多视角并行审稿不可用（服务端未装配）' }
      }
      const ps = perspectives ?? ['剧情逻辑', '文风文笔', '读者体验', '商业潜力']
      const results = await ctx.spawnReviewers({ perspectives: ps, instruction })
      return { count: results.length, results }
    },
  })

  return withErrorCapture('tools', {
    ...fsTools,
    ...trackingTools,
    Bash: bashTool,
    load_skill: loadSkillTool,
    switch_mode: switchModeTool,
    tts_preview: ttsPreviewTool,
    web_search: webSearchTool,
    web_fetch: webFetchTool,
    browser_cdp: browserCdpTool, // 扫榜主工具：CDP 驱动 9222 调试浏览器（status/setup/open/eval/snapshot/click/type/scroll/login）
    ask_ai: askAiTool, // 网页 AI 生成通道（通道 B）：自包含 prompt → 内置浏览器交互 → 一次返回答案
    webai_draw: webAiDrawTool, // 网页 AI 生图通道（人物头像）：豆包生图 → 下载 → 写 设定/头像/ 一次完成
    review_agents: reviewAgentsTool,
    save_report: saveReportTool,
    ask_questions: askQuestionsTool,
    ask_confirm: askConfirmTool,
  })
}
