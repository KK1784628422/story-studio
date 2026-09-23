/**
 * 预加载脚本：contextBridge 暴露最小安全 API 给渲染进程（禁 nodeIntegration）。
 * 渲染进程经 window.storyDesktop.* 访问 Agent浏览器能力，拿不到 Node/Electron 全量 API。
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface EmbeddedBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface EmbeddedNavState {
  url: string
  canBack: boolean
  canForward: boolean
}

const api = {
  /** Agent浏览器：显示/隐藏并把画面盖在指定屏幕区域（前端占位 div 的 getBoundingClientRect） */
  embeddedSetBounds: (bounds: EmbeddedBounds | null): Promise<void> =>
    ipcRenderer.invoke('embedded:set-bounds', bounds),
  /** Agent浏览器：导航到 url（agent 之外的少量手动导航，如登录起点） */
  embeddedNavigate: (url: string): Promise<void> =>
    ipcRenderer.invoke('embedded:navigate', url),
  /** Agent浏览器：当前 CDP 端口（展示/诊断用） */
  embeddedCdpPort: (): Promise<number | null> =>
    ipcRenderer.invoke('embedded:cdp-port'),
  /** Agent浏览器：导航状态快照（当前网址 + 后退/前进可用性） */
  embeddedNav: (): Promise<EmbeddedNavState> => ipcRenderer.invoke('embedded:nav'),
  /** Agent浏览器：导航动作（back/forward/reload/home） */
  embeddedNavAction: (action: 'back' | 'forward' | 'reload' | 'home'): Promise<void> =>
    ipcRenderer.invoke('embedded:nav-action', action),
  /** Agent浏览器：订阅导航状态变化（返回取消订阅函数） */
  onEmbeddedNavState: (cb: (nav: EmbeddedNavState) => void): (() => void) => {
    const handler = (_e: unknown, nav: EmbeddedNavState): void => cb(nav)
    ipcRenderer.on('embedded:nav-state', handler)
    return () => ipcRenderer.removeListener('embedded:nav-state', handler)
  },
  /** 平台标识（前端据此调整「在系统浏览器打开」等行为） */
  platform: process.platform,
  /** 主题切换 → 同步 Windows 原生标题栏（最小化/最大化/关闭）配色（非 Windows/旧壳静默忽略） */
  setTitleBarOverlay: (colors: { color: string; symbolColor: string }): Promise<void> =>
    ipcRenderer.invoke('titlebar:overlay', colors),
  /** 音乐播放器：窗口置顶（true）/ 置于下层（false，取消 alwaysOnTop） */
  setAlwaysOnTop: (on: boolean): Promise<void> => ipcRenderer.invoke('win:set-always-on-top', on),
}

export type StoryDesktopApi = typeof api

contextBridge.exposeInMainWorld('storyDesktop', api)
