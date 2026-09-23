/**
 * WS 事件总线：chokidar 监听书工作区（正文/大纲/设定/追踪）→ file:changed 广播；
 * 门禁/追踪/模式切换事件由工具上下文注入。
 */
import chokidar from 'chokidar'
import type { FastifyInstance } from 'fastify'
import { WebSocket, WebSocketServer } from 'ws'
import { relative, resolve } from 'node:path'
import type { WsEvent } from '@story-studio/shared'
import { localTimestamp } from './log.ts'

export class EventHub {
  private sockets = new Set<WebSocket>()
  private inited = false

  emit(event: WsEvent): void {
    const data = JSON.stringify(event)
    for (const ws of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue
      try {
        ws.send(data)
      } catch {
        // 单个 socket 发送失败绝不能反噬广播调用方（chatLog / onFinish / 门禁路径，
        // 反噬会成为 unhandled rejection → 进程崩溃）：移除连接等待 close 兜底
        this.sockets.delete(ws)
        try {
          ws.terminate()
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  attach(server: import('node:http').Server): void {
    if (this.inited) return // 幂等：防重复装配产生重复 upgrade 监听
    this.inited = true
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? ''
      // 只处理精确的 /ws（不能按前缀 /ws 匹配，否则同一 socket 被多个
      // WebSocketServer handleUpgrade → 报错）
      if (url !== '/ws' && !url.startsWith('/ws?')) return
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.sockets.add(ws)
        ws.on('close', () => this.sockets.delete(ws))
        ws.on('error', () => {
          this.sockets.delete(ws)
          try {
            ws.terminate()
          } catch {
            /* 忽略 */
          }
        })
      })
    })
    // http server 关闭时清理所有 socket，避免优雅停机残留半开连接
    server.on('close', () => {
      for (const ws of this.sockets) {
        try {
          ws.terminate()
        } catch {
          /* 忽略 */
        }
      }
      this.sockets.clear()
    })
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  /** 日志推送到前端日志抽屉（debug 用） */
  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.emit({ type: 'log', level, msg, at: localTimestamp() })
  }
}

type FileKind = 'chapter' | 'outline' | 'setting' | 'tracking' | 'report' | 'source'

function kindFor(rel: string): FileKind | null {
  if (rel.startsWith('正文/')) return 'chapter'
  if (rel.startsWith('大纲/')) return 'outline'
  if (rel.startsWith('设定/')) return 'setting'
  if (rel.startsWith('追踪/')) return 'tracking'
  if (rel.startsWith('.story-studio/reports/')) return 'report'
  if (rel.startsWith('原著/')) return 'source'
  return null
}

export function watchWorkspace(hub: EventHub, workspace: string): () => Promise<void> {
  const ws = resolve(workspace)
  const watcher = chokidar.watch([resolve(ws, '正文'), resolve(ws, '大纲'), resolve(ws, '设定'), resolve(ws, '追踪'), resolve(ws, '.story-studio', 'reports'), resolve(ws, '原著')], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  const onChange = (absPath: string) => {
    const rel = relative(ws, absPath).replaceAll('\\', '/')
    const kind = kindFor(rel)
    if (kind) hub.emit({ type: 'file:changed', path: rel, kind })
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  // chokidar 底层错误（EMFILE/目录被删等）无监听会成为 uncaught 异常危险源
  watcher.on('error', (e) => console.warn('[ws] chokidar 监听错误:', e))
  /** 关停监听（热切书时由 state.stopWatcher 调用；进程退出由 index.ts 的 onClose 钩子兜底） */
  return () => watcher.close()
}
