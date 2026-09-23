/** 听书音色/语速抽屉（novel-reader 移植）：听书入口打开时作为「先选音色」面板，含开始按钮 */
import { RATES, VOICES } from './Reader.tsx'

interface Props {
  open: boolean
  voiceKey: string
  rate: string
  onVoice: (key: string) => void
  onRate: (rate: string) => void
  onClose: () => void
  /** 选好音色后开始朗读（听书入口接入时提供） */
  onStart?: () => void
}

export function VoicePanel({ open, voiceKey, rate, onVoice, onRate, onClose, onStart }: Props) {
  return (
    <>
      <div
        className={`drawer-mask${open ? ' open' : ''}`}
        onClick={onClose}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      />
      <div className={`drawer voice-drawer${open ? ' open' : ''}`}>
        <div className="drawer-head">
          <h2>听书设置</h2>
          <button className="drawer-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="vp-section">
          <h3>音色</h3>
          <div className="vp-grid">
            {VOICES.map((v) => {
              const key = `${v.id}|${v.pitch}`
              return (
                <button
                  key={key}
                  className={`vp-chip${voiceKey === key ? ' active' : ''}`}
                  onClick={() => onVoice(key)}
                >
                  {v.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="vp-section">
          <h3>语速</h3>
          <div className="vp-grid">
            {RATES.map((r) => (
              <button
                key={r.value}
                className={`vp-chip${rate === r.value ? ' active' : ''}`}
                onClick={() => onRate(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <p className="vp-note">听书走微软 Edge 语音服务（服务端合成+缓存）；同一文本二次播放走离线缓存。</p>
        {onStart && (
          <div className="vp-footer">
            <button type="button" className="vp-start" onClick={onStart}>
              ▶ 开始听书
            </button>
          </div>
        )}
      </div>
    </>
  )
}
