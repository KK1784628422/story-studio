/**
 * 设置中心「外观 · 桌宠」区块（桌宠个性化统一入口）：
 *  - 显示桌宠开关（默认开启；持久化，跟随用户上一次的选择）；
 *  - 位置：迷你输入栏示意图复刻输入栏与桌宠的相对相对位置（桌宠站在输入栏肩上），
 *    支持左右拖动、三档吸附（左/中/右），松手落档生效——「三档滑动变阻器」交互；
 *  - 大小 / 话痨密度：分段选择。
 * 偏好读写走 chat/petPrefs.ts 共享仓库，与桌宠本体即时同步、localStorage 持久化。
 */
import { useRef, useState } from 'react'
import imgIdle from '../assets/pet/pet-idle.webp'
import { usePetPrefs, updatePetPrefs, PET_POS_LABEL, type PetPos } from './petPrefs.ts'

/** 迷你滑条几何（与 CSS .pet-pos-slider 尺寸对应） */
const SLIDER_W = 264
/** 三个档位的桌宠指示器中心 x（左右档各留出半只桌宠的边距） */
const DETENTS: Array<[PetPos, number]> = [
  ['left', 26],
  ['center', SLIDER_W / 2],
  ['right', SLIDER_W - 26],
]

function PosSlider({ value, disabled }: { value: PetPos; disabled: boolean }): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  /** 拖动中的指示器 x（px）；null=未拖动（落在当前档位上） */
  const [dragX, setDragX] = useState<number | null>(null)
  const draggingRef = useRef(false)
  /** 拖动点实时坐标走 ref：pointerup 不读 state（React 提交滞后于指针事件流，闭包值会过期） */
  const dragXRef = useRef<number | null>(null)

  const posOf = (p: PetPos): number => DETENTS.find((d) => d[0] === p)![1]
  const px = dragX ?? posOf(value)

  const moveTo = (clientX: number): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(DETENTS[0][1], Math.min(DETENTS[2][1], ((clientX - rect.left) / rect.width) * SLIDER_W))
    dragXRef.current = x
    setDragX(x)
  }

  return (
    <div
      ref={trackRef}
      className={`pet-pos-slider${dragX !== null ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      role="slider"
      aria-label="桌宠位置（左 / 中 / 右 三档）"
      aria-valuetext={PET_POS_LABEL[value]}
      onPointerDown={(e) => {
        if (disabled) return
        draggingRef.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        moveTo(e.clientX)
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current || disabled) return
        moveTo(e.clientX)
      }}
      onPointerUp={() => {
        if (!draggingRef.current) return
        draggingRef.current = false
        // 松手吸附最近档位（三档滑动变阻器）
        const x = dragXRef.current
        setDragX(null)
        dragXRef.current = null
        if (x === null) return
        let best: PetPos = 'center'
        let bd = Infinity
        for (const [p, dx] of DETENTS) {
          const d = Math.abs(dx - x)
          if (d < bd) {
            bd = d
            best = p
          }
        }
        updatePetPrefs({ pos: best })
      }}
      onPointerCancel={() => {
        draggingRef.current = false
        setDragX(null)
        dragXRef.current = null
      }}
    >
      {/* 迷你输入栏：1:1 复刻真实输入栏（+ 钮 / 占位文本 / 模型·思考行 / 发送钮），
          背景随主题走 .prompt-input 同款（30-themes.css 定点回写）；纯示意，不可输入 */}
      <div className="pet-pos-bar" aria-hidden>
        <span className="pb-top">
          <span className="pb-plus">+</span>
          <span className="pb-hint">说点什么…（Enter 发送 / Shift+Enter 换行）</span>
        </span>
        <span className="pb-row">
          <span className="pb-sel">go/deepseek-v4-flash</span>
          <span className="pb-sel">思考：极大（默认）</span>
          <span className="pb-send">↑</span>
        </span>
      </div>
      {/* 三档刻度 + 档位名 */}
      {DETENTS.map(([p, x]) => (
        <span key={p} className="pet-pos-tick" style={{ left: `${(x / SLIDER_W) * 100}%` }} data-on={p === value}>
          {PET_POS_LABEL[p]}
        </span>
      ))}
      {/* 桌宠指示器（拖动头，站在迷你输入栏肩上，与真实桌宠同款立绘） */}
      <div
        className="pet-pos-knob"
        style={{ left: `${(px / SLIDER_W) * 100}%` }}
      >
        <img src={imgIdle} alt="" draggable={false} />
      </div>
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={`pet-seg${disabled ? ' disabled' : ''}`}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          className={value === v ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function PetSettings(): React.JSX.Element {
  const prefs = usePetPrefs()
  const hidden = prefs.hidden

  return (
    <div className={`pet-settings-card${hidden ? ' hidden' : ''}`}>
      <div className="pet-set-row head">
        <div className="pet-set-title">
          <b>桌宠小伙伴</b>
          <i>{hidden ? '已隐藏——打开开关让它回到输入栏' : PET_POS_LABEL[prefs.pos]} · {hidden ? '' : '站在输入栏肩上'}</i>
        </div>
        {/* 显示开关：默认开启（显示），持久化跟随用户上一次的选择 */}
        <button
          type="button"
          className={`pet-toggle${hidden ? '' : ' on'}`}
          role="switch"
          aria-checked={!hidden}
          aria-label="显示桌宠"
          onClick={() => updatePetPrefs({ hidden: !prefs.hidden })}
        />
      </div>

      <div className={`pet-set-body${hidden ? ' disabled' : ''}`}>
        <div className="pet-set-row col">
          <span className="pet-set-label">位置（左右拖动，三档吸附）</span>
          <PosSlider value={prefs.pos} disabled={hidden} />
        </div>
        <div className="pet-set-row">
          <span className="pet-set-label">大小</span>
          <Seg
            value={prefs.size}
            options={[
              ['sm', '小'],
              ['md', '中'],
              ['lg', '大'],
            ]}
            disabled={hidden}
            onChange={(size) => updatePetPrefs({ size })}
          />
        </div>
        <div className="pet-set-row">
          <span className="pet-set-label">话痨密度</span>
          <Seg
            value={prefs.chat}
            options={[
              ['quiet', '静默'],
              ['normal', '适中'],
              ['chatty', '话痨'],
            ]}
            disabled={hidden}
            onChange={(chat) => updatePetPrefs({ chat })}
          />
        </div>
      </div>
    </div>
  )
}
