/** 设置中心「外观 · 动态背景」卡片：上传 ≤100M MP4 作为全页面背景（虚化程度 0-1 可滑调，含预览 / 清除）。
 *  视频经 /api/background 上传存到服务端 .local/background.mp4；App 根渲染全页 <video> 背景（blur 值 localStorage 持久化）。
 *  切换/上传/清除后经 onChanged 通知 App 刷新全局背景层。 */
import { useEffect, useRef, useState } from 'react'
import { clearBackground, uploadBackground, type BackgroundInfo } from '../api.ts'

const MAX_MB = 100

export function BackgroundSettings({ bg, blur, onChanged, onBlurChange }: {
  bg: BackgroundInfo
  blur: number
  onChanged: (next: BackgroundInfo) => void
  onBlurChange: (v: number) => void
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  // 预览 blob URL 生命周期：换文件/清除/卸载时回收，避免内存泄漏
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return
    setErr('')
    const isMp4 = f.type === 'video/mp4' || /\.mp4$/i.test(f.name)
    if (!isMp4) {
      setErr('仅支持 MP4 文件')
      return
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setErr(`文件过大：动态背景仅支持不超过 ${MAX_MB}M 的 MP4（当前 ${(f.size / 1024 / 1024).toFixed(1)}M）`)
      return
    }    setBusy(true)
    try {
      // 上传前先用本地 blob 预览（即时反馈），上传成功后由 App 切到服务端 URL
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(f))
      onChanged(await uploadBackground(f))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
      onChanged(await clearBackground())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const active = bg.enabled
  const videoSrc = previewUrl ?? (active ? `/api/background/video?t=${bg.size}` : null)

  return (
    <div className="bg-settings">
      <div className="bg-settings-head">
        <div className="bg-settings-title">
          <b>动态背景</b>
          <i>{active ? `已启用 · 全页背景（${(bg.size / 1024 / 1024).toFixed(1)}M）` : '上传 MP4 视频作为整个页面的动态背景（虚化程度可调）'}</i>
        </div>
        {active && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void clear()}>
            清除
          </button>
        )}
      </div>

      <div className={`bg-preview${videoSrc ? ' on' : ''}`}>
        {videoSrc ? (
          // 预览按页面 1/4 尺寸等比呈现虚化（页面 blur 上限 36px → 预览 9px），所见即所得
          <video src={videoSrc} autoPlay loop muted playsInline style={{ filter: `blur(${(blur * 9).toFixed(1)}px)` }} />
        ) : (
          <span className="bg-preview-empty">未设置背景视频</span>
        )}
      </div>

      <div className="bg-set-blur">
        <span className="pet-set-label">虚化程度</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={blur}
          onChange={(e) => onBlurChange(Number(e.target.value))}
          aria-label="背景虚化程度（0 清晰 - 1 最虚）"
        />
        <span className="bg-set-blur-val">{Math.round(blur * 100)}%</span>
      </div>

      <div className="bg-settings-actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '上传中…' : active ? '更换视频' : '上传视频'}
        </button>
        <span className="bg-settings-hint">MP4 · 不超过 {MAX_MB}M · 循环播放，虚化程度可随时调节</span>
      </div>

      {err && <div className="bg-settings-err">{err}</div>}

      {/* 隐藏文件选择 */}
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4,.mp4"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}
