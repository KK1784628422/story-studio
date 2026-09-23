/**
 * Story Studio Server：Fastify 启动
 *   - POST /api/chat（SSE Agent 聊天）
 *   - /api/config|book|chapter|doc|sessions|tts（预览与配置）
 *   - /ws（文件变更/门禁/追踪事件推送）
 *   - 静态托管 apps/web/dist（pnpm build 后）
 * 只绑 127.0.0.1，无任何公网暴露。
 */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { loadEnv, ensureStudioDirs, ensureSpaceDirs } from './env.ts'
import { EventHub, watchWorkspace } from './ws.ts'
import { buildAppState } from './state.ts'
import { initLogger, chatLog } from './log.ts'
import { initUsageStats } from './usageStats.ts'
import { setChatLogger } from '@story-studio/agent-core'
import { registerChatRoute } from './routes/chat.ts'
import { registerApiRoutes } from './routes/api.ts'
import { registerWorkspaceRoutes } from './routes/workspace.ts'
import { registerSpacesRoutes } from './routes/spaces.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerFanficRoutes } from './routes/fanfic.ts'
import { registerMusicRoutes } from './routes/music.ts'
import { registerBackgroundRoutes } from './routes/background.ts'
import { startLocalMusicApi } from './music-api.ts'
import { readLastWorkspace } from './workspaceStore.ts'

/** 启动后自动打开默认浏览器（欢迎页选择创作目录）；失败仅告警不阻断服务 */
function openBrowser(url: string, enabled: boolean): void {
  if (!enabled) return
  const bin = process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args =
    process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Start-Process '${url}'`]
      : [url]
  execFile(bin, args, (err) => {
    if (err) console.warn(`[server] 自动打开浏览器失败，请手动访问 ${url}: ${err.message}`)
  })
}

async function main(): Promise<void> {
  const rootDir = resolve(import.meta.dirname, '..', '..', '..')
  const env = loadEnv(rootDir)
  // 启动默认用「上次打开的书」（.local/workspace.json；目录已删回落 .env）——
  // 仅作为服务端默认与欢迎页「最近创作」的数据源，前端始终先过欢迎页
  const lastWs = readLastWorkspace(rootDir)
  let fromLast = false
  if (lastWs && lastWs !== resolve(env.workspace)) {
    if (existsSync(lastWs) && statSync(lastWs).isDirectory()) {
      env.workspace = lastWs
      fromLast = true
    } else {
      console.warn(`[server] 上次工作区不存在，回落 .env 默认：${lastWs}`)
    }
  }
  ensureStudioDirs(env.workspace)
  ensureSpaceDirs(env.spaceDir)

  const hub = new EventHub()
  const state = buildAppState(env, hub)

  // 聊天日志：文件 + stdout + 前端抽屉（排查 Agent 停止/审批续流问题）
  initLogger(rootDir, hub)
  initUsageStats(rootDir)
  setChatLogger((level, msg) => {
    chatLog(level, msg)
  })

  // 全局兜底：异步/同步未捕获异常不再让进程静默蒸发（本地单用户应用，记录后保持运行便于排查）。
  // 注册后覆盖 Node 默认的「unhandledRejection 即退出」，避免无日志崩溃。
  // 防重入：若记录异常的过程本身又抛错（历史事故：stdout EPIPE × chatLog → 自激死循环
  // 写爆 3GB/384 万行），in-flight 标志直接丢弃后续异常——日志系统绝不能被异常处理器反噬
  let handlingCrash = false
  const crashGuard = (kind: string, detail: string): void => {
    if (handlingCrash) return
    handlingCrash = true
    try {
      chatLog('error', `[server] ${kind}: ${detail}`)
    } catch {
      /* chatLog 自身失败：无路可走，静默保进程 */
    } finally {
      handlingCrash = false
    }
  }
  process.on('unhandledRejection', (reason) => {
    crashGuard('unhandledRejection', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })
  process.on('uncaughtException', (err) => {
    crashGuard('uncaughtException', err instanceof Error ? err.stack ?? err.message : String(err))
  })

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
  })

  // 动态背景视频上传走二进制 body（≤100M MP4），不走 JSON 解析；解析器级 bodyLimit 覆盖全局 32M
  app.addContentTypeParser('video/mp4', { parseAs: 'buffer', bodyLimit: 110 * 1024 * 1024 }, (_req, body, done) => done(null, body))
  // 兜底：部分浏览器带参数（video/mp4; codecs=...）或 file input 未带 MIME 时用 octet-stream
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 110 * 1024 * 1024 }, (_req, body, done) => done(null, body))

  registerChatRoute(app, state)
  registerApiRoutes(app, state)
  registerWorkspaceRoutes(app, state)
  registerSpacesRoutes(app, state)
  registerSettingsRoutes(app, state)
  registerFanficRoutes(app, state)
  registerMusicRoutes(app, state)
  registerBackgroundRoutes(app, state)
  // 本地音乐解析 API 进程内托管（零配置；远程 apiBase 不动）；随 onClose 统一关闭
  let stopMusicApi: (() => Promise<void>) | null = null
  void startLocalMusicApi(state)
    .then((close) => {
      stopMusicApi = close
    })
    .catch((err) => {
      console.error(`[music] 解析 API 初始化异常: ${err instanceof Error ? err.message : String(err)}`)
    })
  state.stopWatcher = watchWorkspace(hub, env.workspace)
  // 进程退出兜底：关停当前监听（热切书后 stopWatcher 已指向新监听）
  app.addHook('onClose', async () => {
    await state.stopWatcher()
    await stopMusicApi?.()
  })

  // 静态托管前端（生产形态：单目录部署）
  // 缓存策略：index.html 必须 no-cache（否则浏览器缓存旧入口 → 新构建的 hash 文件名永远加载不到，
  // 表现为「改了代码刷新没变化」）；/assets 内文件名带内容 hash → 长缓存 immutable
  const webDist = join(state.rootDir, 'apps', 'web', 'dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: false,
      setHeaders: (res, pathName) => {
        if (pathName.includes(`${sep}assets${sep}`)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('cache-control', 'no-cache')
        }
      },
    })
    app.get('/', (_req, reply) => reply.sendFile('index.html'))
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  await app.listen({ port: env.port, host: '127.0.0.1' })
  hub.attach(app.server)

  console.log('──────────────────────────────────────────────')
  console.log(`  Story Studio  http://127.0.0.1:${env.port}`)
  console.log(`  书工作区      ${env.workspace}${fromLast ? '（上次打开）' : ''}`)
  console.log(`  模型          ${env.modelId} @ ${env.baseUrl}`)
  console.log(`  技能          ${state.skills.list().length} 个（vendor: ${state.skills.root}）`)
  console.log(`  API key       ${env.apiKey ? '已配置' : '!! 未配置（检查 .env）'}`)
  console.log(`  浏览器通道    桌面模式=Agent浏览器（.local/embedded-cdp-port 协调）；纯浏览器模式=browser_cdp + 9222 调试 Chrome`)
  console.log(`  前端          ${existsSync(webDist) ? `静态托管 ${webDist}` : '未构建（dev 模式：pnpm dev:web → http://127.0.0.1:5173）'}`)
  console.log('──────────────────────────────────────────────')

  // 启动后自动打开浏览器到欢迎页（先选创作目录再进入）
  openBrowser(`http://127.0.0.1:${env.port}/`, env.autoOpen)
}

main().catch((err) => {
  console.error('[server] 启动失败:', err)
  process.exit(1)
})
