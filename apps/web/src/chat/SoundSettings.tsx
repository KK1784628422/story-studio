/**
 * 设置中心「外观 · 提醒音效」区块（Agent 需要用户拍板/操作时的声音提醒配置）：
 *  - 总开关（默认开，持久化跟随上一次选择）；
 *  - 音效选择：3 种内置（点击即选中并试听）+ 自定义音频（MP4 等，时长 ≤5 秒、≤2MB，
 *    上传成功自动切换选中；已导入后点卡片=选中，「更换」按钮重新上传）；
 *  - 音量滑条（0~100%）+ 试听按钮；
 *  - 触发场景说明（审批 / 表单 / 登录 / 超时拍板 / 步数上限 / 门禁转人工）。
 * 读写走 chat/soundAlert.ts 共享仓库，与 ChatPanel 触发点即时同步、localStorage 持久化。
 */
import { useRef, useState } from 'react'
import { Icon } from '../components/Icon.tsx'
import {
  SOUND_OPTIONS,
  MAX_CUSTOM_SEC,
  playAlertSound,
  saveCustomSound,
  updateSoundPrefs,
  useSoundPrefs,
} from './soundAlert.ts'

export function SoundSettings(): React.JSX.Element {
  const prefs = useSoundPrefs()
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return
    setErr(null)
    setBusy(true)
    try {
      const e = await saveCustomSound(f)
      if (e) setErr(e)
      else updateSoundPrefs({ sound: 'custom' }) // 上传成功自动切换选中
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`sound-settings-card${prefs.enabled ? '' : ' off'}`}>
      <div className="pet-set-row head">
        <div className="pet-set-title">
          <b>提醒音效</b>
          <i>Agent 需要你拍板 / 操作时播放——审批 · 问答表单 · 浏览器登录 · 超时拍板 · 步数上限 · 门禁转人工</i>
        </div>
        {/* 总开关：默认开启，持久化跟随用户上一次的选择 */}
        <button
          type="button"
          className={`pet-toggle${prefs.enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={prefs.enabled}
          aria-label="启用提醒音效"
          onClick={() => updateSoundPrefs({ enabled: !prefs.enabled })}
        />
      </div>

      <div className={`pet-set-body${prefs.enabled ? '' : ' disabled'}`}>
        <div className="pet-set-row col">
          <span className="pet-set-label">音效（点击内置卡片即选中并试听）</span>
          <div className="sound-grid">
            {SOUND_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`sound-card${prefs.sound === o.id ? ' on' : ''}`}
                onClick={() => {
                  updateSoundPrefs({ sound: o.id })
                  playAlertSound()
                }}
              >
                <b>{o.label}</b>
                <i>{o.desc}</i>
              </button>
            ))}
            {/* 自定义：未导入时点卡片=上传；已导入时点卡片=选中，「更换」重传 */}
            <div className={`sound-card custom${prefs.sound === 'custom' ? ' on' : ''}`}>
              <button
                type="button"
                className="sound-card-main"
                onClick={() => (prefs.customData ? updateSoundPrefs({ sound: 'custom' }) : fileRef.current?.click())}
              >
                <b>{busy ? '校验中…' : '自定义音频'}</b>
                <i>
                  {prefs.customData
                    ? prefs.customName || '已导入'
                    : `上传 MP4 · 时长 ≤${MAX_CUSTOM_SEC} 秒`}
                </i>
              </button>
              {prefs.customData && (
                <button type="button" className="sound-card-replace" title="更换音频文件" onClick={() => fileRef.current?.click()}>
                  更换
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="pet-set-row">
          <span className="pet-set-label">音量</span>
          <div className="sound-vol">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              aria-label="提醒音效音量"
              onChange={(e) => updateSoundPrefs({ volume: Number(e.target.value) })}
            />
            <span className="sound-vol-val">{Math.round(prefs.volume * 100)}%</span>
            <button type="button" className="sound-test" onClick={() => playAlertSound()}>
              试听
            </button>
          </div>
        </div>
        {err && (
          <div className="sound-err">
            <Icon name="warning" size={13} /> {err}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp4,.m4a,.mp3"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = '' // 同一文件可重复选择（失败后重选）
          }}
        />
      </div>
    </div>
  )
}
