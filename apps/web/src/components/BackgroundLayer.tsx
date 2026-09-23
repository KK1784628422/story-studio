/** 全页面动态背景层：读取 /api/background/video，铺在最底层，虚化程度可调（0-1 → 0-36px）。
 *  数据由设置中心「外观 · 动态背景」上传（≤100M MP4）；未设置时不渲染（主题静态背景）。
 *  循环静音自动播放（muted 才能绕过自动播放限制），background.mp4 更新后重载。 */
import { useEffect, useRef } from 'react'

export function BackgroundLayer({ url, blur }: { url: string; blur: number }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  // 切换/上传新视频后重新加载播放（src 变化时 autoplay 不一定重新触发）
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.load()
    void v.play().catch(() => {
      /* 浏览器拦截自动播放时静默——下次有交互再播，不阻断页面 */
    })
  }, [url])

  return (
    <div className="bg-layer" aria-hidden>
      <video
        ref={videoRef}
        src={url}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        style={{ filter: `blur(${(blur * 36).toFixed(1)}px) saturate(1.05)` }}
      />
    </div>
  )
}
