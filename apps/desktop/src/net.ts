/** 端口探测：找 127.0.0.1 上的空闲端口（内置浏览器 CDP / server 兜底用） */
import { createServer } from 'node:net'

/** 拿一个 OS 分配的空闲端口（监听后立即释放，存在极小的竞态，本地单用户可接受） */
export function getFreePort(preferred?: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', (err) => {
      // 首选端口被占 → 退回 OS 分配（port 0）
      if (preferred) {
        getFreePort().then(resolvePromise, reject)
      } else {
        reject(err)
      }
    })
    srv.listen(preferred ?? 0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolvePromise(port))
    })
  })
}
