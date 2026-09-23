/**
 * 手机模型外壳（全屏化 + 4px 纤细黑边）：内容铺满，状态栏随阅读器主题同色。
 * 硬件装饰：仅保留状态栏居中灵动岛（摄像头镜点）；装饰件纯展示（aria-hidden）。
 */
import { useEffect, useState } from 'react'

interface Props {
  title?: string
  children: React.ReactNode
}

function fmtTime(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

export function PhoneFrame({ children }: Props) {
  const [time, setTime] = useState(fmtTime)
  useEffect(() => {
    const t = window.setInterval(() => setTime(fmtTime()), 15_000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="phone">
      <div className="phone-statusbar">
        <span className="ps-time">{time}</span>
        <span className="phone-island" aria-hidden="true">
          <i className="phone-cam" />
        </span>
        <span className="ps-right">
          <span className="ps-signal">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="ps-net">4G</span>
          <span className="ps-batt">
            <i className="ps-batt-body">
              <i className="ps-batt-fill" />
            </i>
            <span className="ps-batt-pct">100</span>
          </span>
        </span>
      </div>
      <div className="phone-screen">{children}</div>
    </div>
  )
}
