/** 配置装载（.env → 环境变量；key 只存在内存与环境变量，绝不落书工作区） */
import { config as loadDotenv } from 'dotenv'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ServerEnv {
  baseUrl: string
  apiKey: string
  modelId: string
  workspace: string
  port: number
  /** 启动后自动打开浏览器（欢迎页选择创作目录） */
  autoOpen: boolean
  /** 空间目录（项目内，.story-spaces）：最近书记录 + 历史会话，与书工作目录解耦 */
  spaceDir: string
}

export function loadEnv(rootDir: string): ServerEnv {
  loadDotenv({ path: resolve(rootDir, '.env') })

  const baseUrl = process.env.STORY_STUDIO_MODEL_BASE_URL ?? 'https://api.deepseek.com/v1'
  const apiKey = process.env.STORY_STUDIO_API_KEY ?? ''
  const modelId = process.env.STORY_STUDIO_MODEL_ID ?? 'deepseek-chat'
  const workspace = resolve(process.env.STORY_STUDIO_WORKSPACE ?? '.')
  const port = Number.parseInt(process.env.STORY_STUDIO_PORT ?? '8100', 10)
  const autoOpen = (process.env.STORY_STUDIO_AUTO_OPEN ?? 'true').toLowerCase() !== 'false'
  const spaceDir = resolve(rootDir, '.story-spaces')

  if (!apiKey) {
    console.warn('[env] STORY_STUDIO_API_KEY 未设置——Agent 联调将失败，请复制 .env.example 为 .env 并填写。')
  }

  return { baseUrl, apiKey, modelId, workspace, port, autoOpen, spaceDir }
}

/** 引导空间目录（.story-spaces）：会话子目录等（纯附加） */
export function ensureSpaceDirs(spaceDir: string): void {
  for (const sub of ['sessions']) {
    mkdirSync(resolve(spaceDir, sub), { recursive: true })
  }
}

/** 引导 .story-studio 目录与偏好文件（纯附加，删除不影响书稿） */
export function ensureStudioDirs(workspace: string): void {
  const studio = resolve(workspace, '.story-studio')
  for (const sub of ['sessions', 'history', 'inbox', 'reports', 'tmp', 'tts-cache', 'scratch']) {
    mkdirSync(resolve(studio, sub), { recursive: true })
  }
  const prefs = resolve(studio, 'preferences.md')
  if (!existsSync(prefs)) {
    writeFileSync(
      prefs,
      [
        '# 用户固化偏好',
        '',
        '- 不卡字数硬下限，文笔 > 文风 > 情绪 > 字数。',
        '- 正文避免 AI 腔；blocking 质检必须清零。',
        '',
        '（本文件内容会注入 Agent 系统提示词的 [用户约束] 段，可随时修改。）',
        '',
      ].join('\n'),
      'utf8',
    )
  }
}

export function readPreferences(workspace: string): string {
  const prefs = resolve(workspace, '.story-studio', 'preferences.md')
  if (!existsSync(prefs)) return ''
  return readFileSync(prefs, 'utf8').slice(0, 4000)
}
