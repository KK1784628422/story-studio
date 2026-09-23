#!/usr/bin/env node
/**
 * ask_ai 工具端到端验证（不经模型，直接调工具 execute）：
 * 前置：桌面端已启动（.local/embedded-cdp-port 存在）且内置浏览器已登录目标站点。
 * 用法：node scripts/askai-e2e.ts [prompt] [site]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserCdpClient } from '../packages/tools/src/browser.ts'
import { createAskAiTool } from '../packages/tools/src/askai/index.ts'
import type { ToolContext } from '../packages/tools/src/context.ts'

const root = resolve(import.meta.dirname, '..')
const portFile = join(root, '.local', 'embedded-cdp-port')
if (!existsSync(portFile)) {
  console.error('[askai-e2e] 未找到 .local/embedded-cdp-port——请先启动桌面端（pnpm dev:desktop）')
  process.exit(1)
}

const prompt = process.argv[2] ?? '写一首关于春天的五言绝句，只输出诗句'
const site = process.argv[3]

const browser = new BrowserCdpClient({
  agentBrowserJs: join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js'),
  skillsRoot: join(root, 'packages', 'skills', 'vendor'),
})

const ctx = {
  browser,
  events: { emit: (e: { type: string }) => console.log(`[event] ${e.type}`, 'message' in e ? (e as { message?: string }).message : '') },
  signalRef: { current: null },
} as unknown as ToolContext

const askAi = createAskAiTool(ctx)
console.log(`[askai-e2e] site=${site ?? '(默认)'} prompt=${prompt.slice(0, 40)}…`)
const t0 = Date.now()

// 直接调工具 execute（绕过 ai SDK 包装层）
const exec = (askAi as unknown as { execute: (input: { site?: string; prompt: string; maxWaitMs?: number }) => Promise<unknown> }).execute
const result = await exec.call(askAi, { site, prompt, maxWaitMs: 300_000 })
const r = result as { ok: boolean; answer?: string; chars?: number; needLogin?: boolean; error?: string; partialAnswer?: string }

console.log(`[askai-e2e] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ok=${r.ok} chars=${r.chars ?? 0} needLogin=${r.needLogin ?? false}`)
if (r.error) console.log(`[askai-e2e] error: ${r.error}`)
if (r.answer) console.log(`[askai-e2e] answer 预览：\n${r.answer.slice(0, 300)}${r.answer.length > 300 ? '\n……' : ''}`)
if (r.partialAnswer) console.log(`[askai-e2e] partialAnswer 预览：\n${r.partialAnswer.slice(0, 200)}`)
process.exit(r.ok ? 0 : 2)
