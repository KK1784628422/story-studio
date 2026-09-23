/** 工具集共享上下文 */
import type { SkillLoader } from '@story-studio/skills'
import type { ModeId, WsEvent } from '@story-studio/shared'
import type { BashExecutor } from './bash.ts'
import type { GateEngine } from './gate.ts'
import type { EdgeTtsService } from './tts.ts'
import type { BrowserCdpClient } from './browser.ts'
import type { SandboxRoots } from './sandbox.ts'

/** 多视角并行审稿请求（实现由 agent-core 注入，tools 只定义契约） */
export interface ReviewerRequest {
  /** 审查视角（如 剧情逻辑 / 文风文笔 / 读者体验 / 商业潜力） */
  perspectives: string[]
  /** 审查范围与要求（含章节范围、关注点） */
  instruction: string
}

export interface ReviewerResult {
  perspective: string
  report: string
}

export interface ToolContext {
  /** 书工作区（绝对路径，唯一真相源） */
  workspace: string
  sandbox: SandboxRoots
  skills: SkillLoader
  bash: BashExecutor
  gate: GateEngine
  tts: EdgeTtsService
  browser: BrowserCdpClient
  events: { emit(event: WsEvent): void }
  /** 最近加载的技能目录（栈顶优先，供 Bash 脚本解析） */
  loadedSkillDirs: string[]
  /**
   * 当前请求级中止信号（chat.ts 每轮请求写入/清空）。
   * 用户停止 Agent / 客户端断开 → abort → 工具层树杀在跑的子进程（扫榜脚本等）。
   */
  signalRef: { current: AbortSignal | null }
  /** 模式切换回调（持久化到会话） */
  setMode(mode: ModeId): void
  /** 多视角并行审稿（审稿模式 full；由 server 装配注入） */
  spawnReviewers?: (req: ReviewerRequest) => Promise<ReviewerResult[]>
  /** ask_ai 超时用户选择总线（server 注入）：网页 AI 长任务超时后向用户询问「继续等待 / 放弃」。
   *  wait() 挂起直到用户作答（返回 'continue'|'abort'）或 300s 无响应（返回 'timeout'）。 */
  askAiAnswer?: { wait(): Promise<'continue' | 'abort' | 'timeout'> }
}

export interface ToolContextDeps {
  workspace: string
  skills: SkillLoader
  events: { emit(event: WsEvent): void }
  setMode(mode: ModeId): void
  pythonCommand?: string
  /** agent-browser 的 js 入口（node_modules/agent-browser/bin/agent-browser.js） */
  agentBrowserJs?: string
  /** 多视角并行审稿实现（agent-core createReviewerSpawner） */
  spawnReviewers?: (req: ReviewerRequest) => Promise<ReviewerResult[]>
}
