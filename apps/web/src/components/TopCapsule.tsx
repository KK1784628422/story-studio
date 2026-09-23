/**
 * 顶栏动态胶囊（居中悬浮，三段合一，颜色全部跟随主题变量）：
 *  [ Agent 实时状态 ] | [ 模式切换（下拉） ] | [ 正在播放 ]
 *  - Agent 段：复用桌宠的 13 态仲裁结果（ChatPanel onPetLive 上报，与 PetMascot 同源同帧）——
 *    状态点按宠物每态配色（ACCENT），运行中挂实时耗时；
 *  - 模式段：平时只显示当前模式（图标+名+箭头），点击向下展开七模式抽屉（图标+名+desc+对勾）；
 *    Agent 自动切模式时胶囊呼吸一次（用户手动切换不呼吸）；
 *  - 音乐段：播放中三根跳动均衡柱 + 曲名，点击播放/暂停；静止且未配置音乐源时点击直达设置页。
 * 定位：absolute 居中悬浮于顶栏（不贴窗口顶缘），抽屉向下弹出盖在工作区上。
 */
import { useEffect, useRef, useState } from 'react'
import { MODES, modeMeta, type ModeId } from '@story-studio/shared'
import { Icon } from './Icon.tsx'
import { ACCENT, TITLE } from '../chat/PetMascot.tsx'
import type { PetState } from '../chat/usePetState.ts'
import { lyricIndexAt, useNowPlaying } from '../music/nowPlaying.ts'

/** 无光晕态的状态点颜色（idle=待命绿 / capped=琥珀 / stopped=灰，与宠物语义一致） */
const DOT_FALLBACK: Partial<Record<PetState, string>> = {
  idle: '#7cc9a0',
  capped: '#d99a3d',
  stopped: '#8a8274',
}

export interface PetLive {
  state: PetState
  elapsed: number
}

/** Agent 段（宠物同源状态） */
function CapsuleAgent({ petLive, connected }: { petLive: PetLive; connected: boolean }): React.JSX.Element {
  const { state, elapsed } = petLive
  const running = state === 'preparing' || state === 'waiting' || state === 'thinking' || state === 'executing' || state === 'browsing'
  const dot = ACCENT[state] ?? DOT_FALLBACK[state] ?? '#7cc9a0'
  return (
    <div
      className="tc-agent"
      title={connected ? `Agent 状态：${TITLE[state]}` : 'WebSocket 连接断开，自动重连中'}
    >
      <i
        className={`tc-dot${running ? ' running' : ''}${state === 'error' ? ' bad' : ''}`}
        style={{ '--tc-dot': dot } as React.CSSProperties}
        aria-hidden
      />
      {/* key=state：状态变更时文字上滑换字 */}
      <span key={state + (connected ? '' : '-off')} className="tc-agent-text">
        {connected ? TITLE[state] : '连接断开，重连中'}
      </span>
      {running && elapsed > 0 && <span className="tc-timer">{elapsed}s</span>}
    </div>
  )
}

/** 模式段（下拉切换） */
function CapsuleMode({ mode, onMode }: { mode: ModeId; onMode: (m: ModeId) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 用户手动切换标记：手动切换不触发呼吸（呼吸只用于提醒"Agent 替你切了模式"） */
  const userSwitchedRef = useRef(false)
  const meta = modeMeta(mode)

  // 模式变更 → 外部切换（Agent 路由 / WS 同步）呼吸一次；手动切换跳过
  const firstRef = useRef(true)
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    if (userSwitchedRef.current) {
      userSwitchedRef.current = false
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 750)
    return () => clearTimeout(t)
  }, [mode])

  // 点外部 / Esc 关闭抽屉
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="tc-mode-wrap">
      <button
        type="button"
        className="tc-mode"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`当前模式：${meta.label} — ${meta.desc}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={meta.icon} size={14} />
        <span key={mode} className="tc-mode-text">{meta.label}</span>
        <Icon name="chevron-down" size={11} className={`tc-chevron${open ? ' up' : ''}`} />
      </button>
      <div className={`tc-drawer${open ? ' open' : ''}`} role="listbox" aria-label="切换模式">
        <div className="tc-drawer-clip">
          <div className="tc-drawer-body">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === mode}
                className={`tc-item${m.id === mode ? ' on' : ''}`}
                title={m.desc}
                onClick={() => {
                  userSwitchedRef.current = true
                  onMode(m.id)
                  setOpen(false)
                }}
              >
                <Icon name={m.icon} size={14} />
                <span className="tc-item-text">
                  <b>{m.label}</b>
                  <i>{m.desc}</i>
                </span>
                {m.id === mode && <Icon name="check-circle" size={12} className="tc-check" />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 音乐段：点击打开「设置中心 · 音乐」（配置/扫码登录入口）；播放/暂停用右下角播放器 */
function CapsuleMusic({ onConfigure }: { onConfigure: () => void }): React.JSX.Element {
  const np = useNowPlaying()
  const configured = np.music?.configured === true
  const loggedIn = np.music?.loggedIn === true
  const locked = !configured || !loggedIn
  const title = locked
    ? configured
      ? '音乐源未登录 · 点击去扫码登录'
      : '音乐源未配置 · 点击去设置'
    : `音乐设置（当前：${np.playing ? '播放中' : '已暂停'} · ${np.track?.name ?? '尚未播放'}）`
  // 当前歌词行：点播曲目拉到歌词后，随播放进度同步（悬停可看翻译）
  const line = np.lyric ? np.lyric[lyricIndexAt(np.lyric, np.cur)] : undefined
  return (
    <button
      type="button"
      className={`tc-music${locked ? ' unconfigured' : ''}`}
      title={title}
      onClick={onConfigure}
    >
      {np.playing ? (
        <span className="tc-eq" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="volume" size={13} />
      )}
      <span className="tc-music-text">{locked ? (configured ? '音乐未登录' : '音乐未配置') : (np.track?.name ?? '尚未播放')}</span>
      {line && <span className="tc-lyric">{line.text}</span>}
    </button>
  )
}

export function TopCapsule({
  mode,
  onMode,
  petLive,
  connected,
  onConfigure,
}: {
  mode: ModeId
  onMode: (m: ModeId) => void
  petLive: PetLive
  connected: boolean
  onConfigure: () => void
}): React.JSX.Element {
  // 工作中胶囊边缘泛状态色微光（--tc-glow）；idle/capped/stopped 无光晕（与宠物语义一致）
  const atEase = petLive.state === 'idle' || petLive.state === 'capped' || petLive.state === 'stopped' || !connected
  const glow = ACCENT[petLive.state] ?? DOT_FALLBACK[petLive.state]
  return (
    <div
      className={`top-capsule${atEase ? ' at-ease' : ''}`}
      style={glow ? ({ '--tc-glow': glow } as React.CSSProperties) : undefined}
    >
      <CapsuleAgent petLive={petLive} connected={connected} />
      <i className="tc-sep" aria-hidden />
      <CapsuleMode mode={mode} onMode={onMode} />
      <i className="tc-sep" aria-hidden />
      <CapsuleMusic onConfigure={onConfigure} />
    </div>
  )
}
