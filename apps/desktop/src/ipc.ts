/**
 * IPC 桥：渲染进程（Web 前端）↔ 主进程的 Agent浏览器控制通道。
 * contextBridge 在 preload 里挂到 window.storyDesktop；导航状态变化经 embedded:nav-state 推送。
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  embeddedNavAction,
  embeddedNavSnapshot,
  getEmbedded,
  hideEmbedded,
  navigateEmbedded,
  setOnNavChanged,
  showEmbedded,
} from './embeddedBrowser'

const NAV_ACTIONS = new Set(['back', 'forward', 'reload', 'home'])

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('embedded:set-bounds', (_evt, bounds: { x: number; y: number; width: number; height: number } | null) => {
    const win = getWindow()
    if (!win) return
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      hideEmbedded()
      return
    }
    showEmbedded(win, bounds)
  })

  ipcMain.handle('embedded:navigate', (_evt, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      navigateEmbedded(url)
    }
  })

  ipcMain.handle('embedded:cdp-port', () => getEmbedded()?.cdpPort ?? null)

  ipcMain.handle('embedded:nav', () => embeddedNavSnapshot())

  ipcMain.handle('embedded:nav-action', (_evt, action: string) => {
    if (typeof action === 'string' && NAV_ACTIONS.has(action)) {
      embeddedNavAction(action as 'back' | 'forward' | 'reload' | 'home')
    }
  })

  // 主题切换 → 同步 Windows 原生标题栏（最小化/最大化/关闭）配色。非 Windows 无 overlay，静默忽略
  ipcMain.handle('titlebar:overlay', (_evt, colors: { color: string; symbolColor: string }) => {
    const win = getWindow()
    if (!win || process.platform !== 'win32') return
    try {
      win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor })
    } catch {
      /* 旧版 Electron / 非 Windows：忽略 */
    }
  })

  // 音乐播放器置顶/置于下层（置顶 = 窗口 alwaysOnTop；置于下层 = 取消置顶恢复常规层级）
  ipcMain.handle('win:set-always-on-top', (_evt, on: boolean) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    try {
      win.setAlwaysOnTop(!!on, 'floating')
    } catch {
      /* 平台不支持：忽略 */
    }
  })

  // 导航状态变化 → 推给前端（EmbeddedPane 订阅）
  setOnNavChanged((nav) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('embedded:nav-state', nav)
    }
  })
}
