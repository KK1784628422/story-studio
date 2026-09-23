/** 本地音乐解析 API 进程内托管（零配置）：
 *  - 音乐源未配置或指向回环地址但不可达时，直接在本进程内起 NeteaseCloudMusicApi 兼容实例
 *    （依赖随 server 安装，无需 npx、无需手动启动，桌面/浏览器形态行为一致）；
 *  - 端口上已有兼容实例（用户自己起的/上次残留）→ 探活通过直接复用，不重复起；
 *  - 音乐源指向远程地址 → 完全不动（用户自管部署）。
 *  进程内实例随 server 关闭统一 close，不产生孤儿进程。 */
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import type { AppState } from './state.ts'

const DEFAULT_API_BASE = 'http://127.0.0.1:3000'

interface NcmApiModule {
  serveNcmApi: (opts: { port: number; host: string; checkVersion: boolean }) => Promise<{ server: Server }>
}

/** 兼容 API 探活：/search 返回 result 结构才视为可用（防止端口被无关服务占用时误复用） */
async function probe(apiBase: string): Promise<boolean> {
  try {
    const r = await fetch(`${apiBase}/search?keywords=storystudio&limit=1&timestamp=${Date.now()}`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return false
    return !!((await r.json()) as { result?: unknown } | null)?.result
  } catch {
    return false
  }
}

function isLoopback(apiBase: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(apiBase).hostname)
  } catch {
    return false
  }
}

function waitForListen(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/** 音乐源完全未配置时，把本地实例地址写进 settings（与「设置中心 · 音乐」手动保存等效） */
function writeApiBaseIfEmpty(state: AppState, apiBase: string): void {
  const data = state.settings.load()
  if (data.music?.apiBase) return
  state.settings.save({ ...data, music: { platform: 'netease', apiBase } })
  console.log(`[music] 已自动写入音乐源配置：${apiBase}（设置中心可随时改）`)
}

/** 启动/复用本地解析 API；返回进程内实例的关闭函数（复用外部实例或远程部署时返回 null） */
export async function startLocalMusicApi(state: AppState): Promise<(() => Promise<void>) | null> {
  const music = state.settings.load().music
  if (music?.apiBase && !isLoopback(music.apiBase)) return null

  const apiBase = music?.apiBase || DEFAULT_API_BASE
  if (await probe(apiBase)) {
    console.log(`[music] 解析 API 已在运行，直接复用：${apiBase}`)
    writeApiBaseIfEmpty(state, apiBase)
    return null
  }

  const port = Number(new URL(apiBase).port) || 3000
  console.log(`[music] 正在进程内启动本地解析 API：${apiBase} …`)
  let httpServer: Server
  try {
    const { serveNcmApi } = createRequire(import.meta.url)('NeteaseCloudMusicApi/server.js') as NcmApiModule
    const ncmApp = await serveNcmApi({ port, host: '127.0.0.1', checkVersion: false })
    httpServer = ncmApp.server
    await waitForListen(httpServer)
  } catch (err) {
    console.error(`[music] 本地解析 API 启动失败（${apiBase}）：${err instanceof Error ? err.message : String(err)}；音乐播放器不可用，请到「设置中心 · 音乐」改指自建端点`)
    return null
  }
  if (!(await probe(apiBase))) console.warn(`[music] 解析 API 已监听 ${apiBase} 但探活未通过，点播可能异常`)
  else console.log(`[music] 本地解析 API 就绪：${apiBase}`)
  writeApiBaseIfEmpty(state, apiBase)
  return () => new Promise((resolve) => httpServer.close(() => resolve()))
}
