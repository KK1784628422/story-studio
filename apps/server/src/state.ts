/** 服务端全局状态装配（启动时构建一次；多书管理下 workspace 可热切换） */
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { SkillLoader } from '@story-studio/skills'
import { createToolContext, createTools, type ToolContext } from '@story-studio/tools'
import { StoryAgentRuntime, SessionStore, createReviewerSpawner } from '@story-studio/agent-core'
import type { ToolSet } from 'ai'
import type { ServerEnv } from './env.ts'
import { ensureStudioDirs } from './env.ts'
import type { EventHub } from './ws.ts'
import { SettingsStore } from './settings.ts'
import { LocalRouter } from './localRouter.ts'
import { waitAskAiAnswer } from './askAiBus.ts'

export interface AppState {
  env: ServerEnv
  rootDir: string
  skills: SkillLoader
  toolCtx: ToolContext
  tools: ToolSet
  runtime: StoryAgentRuntime
  sessions: SessionStore
  hub: EventHub
  /** 模型 Provider 运行时设置（官方模板/自定义，持久化 .local/settings.json） */
  settings: SettingsStore
  /** L1 本地意图路由分类器（TF-IDF+质心，启动训练，/api/route 中间层） */
  localRouter: LocalRouter
  /** 当前工作区文件监听的关停函数（热切书时重建） */
  stopWatcher: () => Promise<void>
}

export function buildAppState(env: ServerEnv, hub: EventHub): AppState {
  const rootDir = resolve(import.meta.dirname, '..', '..', '..')
  const vendorRoot = join(rootDir, 'packages', 'skills', 'vendor')
  if (!existsSync(vendorRoot)) {
    throw new Error(`技能 vendor 目录不存在：${vendorRoot}。请先运行 pnpm sync-skills。`)
  }

  const skills = new SkillLoader(vendorRoot, join(rootDir, 'packages', 'skills', 'local'))
  const model = { baseUrl: env.baseUrl, apiKey: env.apiKey, modelId: env.modelId }
  // L1 本地意图路由：种子集启动训练（<100ms）；失败自动降级（L1 跳过，不影响聊天）
  const localRouter = new LocalRouter(rootDir)
  localRouter.init()
  const state: AppState = {
    env,
    rootDir,
    skills,
    hub,
    settings: new SettingsStore(rootDir),
    localRouter,
    toolCtx: undefined as unknown as ToolContext,

    tools: undefined as unknown as ToolSet,
    runtime: undefined as unknown as StoryAgentRuntime,
    sessions: undefined as unknown as SessionStore,
    stopWatcher: async () => {},
  }
  mountWorkspace(state, env.workspace)
  return state
}

/** 装配/重建某个工作区的运行时组件（启动与热切书共用） */
function mountWorkspace(state: AppState, workspace: string): void {
  const model = { baseUrl: state.env.baseUrl, apiKey: state.env.apiKey, modelId: state.env.modelId }
  ensureStudioDirs(workspace)

  const toolCtx = createToolContext({
    workspace,
    skills: state.skills,
    events: state.hub,
    setMode: () => {
      // 占位：chat 路由每轮重绑到当前会话
    },
    agentBrowserJs: join(state.rootDir, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js'),
  })
  // ask_ai 超时用户选择总线（前端 POST 写入 → 工具挂起等待；见 askAiBus.ts）
  toolCtx.askAiAnswer = { wait: waitAskAiAnswer }
  const tools = createTools(toolCtx)
  // 多视角并行审稿：子 Agent 复用同一模型端点与只读工具子集
  const spawnReviewers = createReviewerSpawner({ model, tools })
  toolCtx.spawnReviewers = spawnReviewers

  state.env.workspace = resolve(workspace)
  state.toolCtx = toolCtx
  state.tools = tools
  state.runtime = new StoryAgentRuntime({ model, workspace: state.env.workspace, skills: state.skills, tools })
  // 会话统一存空间目录（项目内 .story-spaces/sessions/，按工作区分目录），旧数据构造时自动迁移
  state.sessions = new SessionStore(state.env.workspace, join(state.env.spaceDir, 'sessions'))
}

/** 热切书：关旧监听 → 重建工作区相关组件（skills/model 不变）。调用方负责重启 watcher 与广播。 */
export async function switchBook(state: AppState, newWorkspace: string): Promise<string> {
  await state.stopWatcher()
  mountWorkspace(state, newWorkspace)
  return state.env.workspace
}
