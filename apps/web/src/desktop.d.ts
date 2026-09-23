/** 桌面化（Electron）预加载注入的全局 API 类型声明。
 *  浏览器（非桌面）环境下 window.storyDesktop 为 undefined，前端据此降级。 */
export interface EmbeddedNavState {
  url: string
  canBack: boolean
  canForward: boolean
}

export interface StoryDesktopApi {
  /** Agent浏览器：显示/隐藏并把画面盖在指定屏幕区域 */
  embeddedSetBounds: (bounds: { x: number; y: number; width: number; height: number } | null) => Promise<void>
  /** Agent浏览器：导航到 url */
  embeddedNavigate: (url: string) => Promise<void>
  /** Agent浏览器：当前 CDP 端口 */
  embeddedCdpPort: () => Promise<number | null>
  /** Agent浏览器：导航状态快照（当前网址 + 后退/前进可用性） */
  embeddedNav: () => Promise<EmbeddedNavState>
  /** Agent浏览器：导航动作（back/forward/reload/home） */
  embeddedNavAction: (action: 'back' | 'forward' | 'reload' | 'home') => Promise<void>
  /** Agent浏览器：订阅导航状态变化（返回取消订阅函数） */
  onEmbeddedNavState: (cb: (nav: EmbeddedNavState) => void) => () => void
  platform: string
  /** 主题切换 → 同步 Windows 原生标题栏配色（旧桌面壳无此能力，可选调用） */
  setTitleBarOverlay?: (colors: { color: string; symbolColor: string }) => Promise<void>
  /** 音乐播放器：窗口置顶（true）/ 置于下层（false）。旧桌面壳/浏览器无此能力，可选调用 */
  setAlwaysOnTop?: (on: boolean) => Promise<void>
}

declare global {
  interface Window {
    storyDesktop?: StoryDesktopApi
  }
}

export {}
