/**
 * 用户参与提醒音效（Agent 需要用户拍板/操作时的声音提示）：
 *  - 触发场景（ChatPanel 边沿检测统一驱动）：写入审批停靠 / 问答·确认表单 / Agent 文本提问待回复
 *    / 浏览器人工登录 / 网页 AI 超时拍板 / 步数上限需回复「继续」/ 门禁 3 次不过转人工；
 *  - 内置 3 种音效（WebAudio 现场合成，无音频资源）：叮咚（双音门铃）/ 水滴（上滑滴落）/ 急促（三连短鸣）；
 *  - 自定义：MP4 等音频文件（时长 ≤5s、体积 ≤2MB，data URL 存 localStorage，超限拒绝并提示）；
 *  - 偏好（开关/音效/音量/自定义音频）localStorage 持久化，设置中心「外观 · 提醒音效」配置；
 *  - 浏览器自动播放策略下 AudioContext 可能被挂起：静默失败不打断页面。
 */
import { useSyncExternalStore } from 'react'

export type SoundId = 'chime' | 'drop' | 'urgent' | 'custom'

export interface SoundPrefs {
  /** 总开关（默认开） */
  enabled: boolean
  /** 音效选择（3 内置 + custom） */
  sound: SoundId
  /** 音量 0~1（默认 0.7） */
  volume: number
  /** 自定义音频文件名（展示用） */
  customName: string
  /** 自定义音频 data URL（≤5s；空串=未上传） */
  customData: string
}

/** 内置音效候选（自定义在设置 UI 单独渲染：需要上传交互） */
export const SOUND_OPTIONS: Array<{ id: SoundId; label: string; desc: string }> = [
  { id: 'chime', label: '叮咚', desc: '双音门铃 · 温和' },
  { id: 'drop', label: '水滴', desc: '清脆上滑 · 轻柔' },
  { id: 'urgent', label: '急促', desc: '三连短鸣 · 紧迫' },
]

const DEFAULTS: SoundPrefs = { enabled: true, sound: 'chime', volume: 0.7, customName: '', customData: '' }
const KEY = 'sound-alert-prefs'
/** 自定义音频体积上限（data URL 进 localStorage，防撑爆配额） */
const MAX_CUSTOM_BYTES = 2 * 1024 * 1024
/** 自定义音频时长上限（秒） */
export const MAX_CUSTOM_SEC = 5

// ── 偏好仓库（与 petPrefs 同模式：模块级缓存 + useSyncExternalStore 多处同步） ──

function load(): SoundPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SoundPrefs>
    return { ...DEFAULTS, ...raw }
  } catch {
    return DEFAULTS
  }
}

let cached: SoundPrefs = load()
const listeners = new Set<() => void>()

export function getSoundPrefs(): SoundPrefs {
  return cached
}

export function updateSoundPrefs(patch: Partial<SoundPrefs>): void {
  cached = { ...cached, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    /* 存不上就仅本次会话生效 */
  }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** React 侧订阅（设置中心与触发点共用，任一处修改双方即时同步） */
export function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(subscribe, getSoundPrefs)
}

// ── 播放引擎 ──

let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!ctx) ctx = new Ctor()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

/** 单音：正弦主音 + 2 倍频泛音（钟磬感），快速起音 + 指数衰减 */
function chimeNote(c: AudioContext, freq: number, at: number, dur: number, vol: number): void {
  const t0 = c.currentTime + at
  const master = c.createGain()
  master.gain.value = vol
  master.connect(c.destination)

  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(1, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g)
  g.connect(master)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)

  const ov = c.createOscillator()
  const og = c.createGain()
  ov.type = 'sine'
  ov.frequency.value = freq * 2
  og.gain.setValueAtTime(0, t0)
  og.gain.linearRampToValueAtTime(0.35, t0 + 0.012)
  og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.6)
  ov.connect(og)
  og.connect(master)
  ov.start(t0)
  ov.stop(t0 + dur + 0.05)
}

/** 水滴：频率快速上滑（bloop）+ 立即衰减 */
function dropNote(c: AudioContext, at: number, f0: number, f1: number, vol: number): void {
  const t0 = c.currentTime + at
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(f0, t0)
  osc.frequency.exponentialRampToValueAtTime(f1, t0 + 0.12)
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(vol, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + 0.25)
}

/** 短促蜂鸣（方波低音量，急促三连用） */
function beep(c: AudioContext, at: number, freq: number, vol: number): void {
  const t0 = c.currentTime + at
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(vol * 0.45, t0 + 0.008)
  g.gain.setValueAtTime(vol * 0.45, t0 + 0.085)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + 0.12)
}

/** 自定义音频播放复用同一元素（避免每次触发新建 <audio>） */
let customEl: HTMLAudioElement | null = null

/** 播放提醒音（读当前偏好）：内置合成 / 自定义音频；任何失败静默不打断页面 */
export function playAlertSound(): void {
  const p = getSoundPrefs()
  if (!p.enabled) return
  const vol = Math.min(1, Math.max(0, p.volume))
  if (p.sound === 'custom') {
    if (!p.customData) return // 未上传自定义音频：静默
    try {
      if (!customEl) customEl = new Audio()
      customEl.src = p.customData
      customEl.volume = vol
      void customEl.play().catch(() => {})
    } catch {
      /* 忽略 */
    }
    return
  }
  const c = audioCtx()
  if (!c) return
  try {
    if (p.sound === 'chime') {
      chimeNote(c, 1318.51, 0, 0.42, vol) // E6
      chimeNote(c, 1046.5, 0.22, 0.55, vol) // C6
    } else if (p.sound === 'drop') {
      dropNote(c, 0, 420, 940, vol)
      dropNote(c, 0.19, 520, 1180, vol * 0.8)
    } else {
      beep(c, 0, 950, vol)
      beep(c, 0.16, 950, vol)
      beep(c, 0.32, 1180, vol)
    }
  } catch {
    /* 无声环境（无音频设备/策略拦截）忽略 */
  }
}

/** 探测音频时长（loadedmetadata；4s 安全超时，读不到返回 0） */
function probeDuration(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio()
    let settled = false
    const done = (v: number): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0)
    a.onerror = () => done(0)
    setTimeout(() => done(Number.isFinite(a.duration) ? a.duration : 0), 4000)
    a.src = dataUrl
  })
}

/** 校验并保存自定义音频：返回错误信息（null=成功，成功后偏好已写入 customData/customName） */
export async function saveCustomSound(file: File): Promise<string | null> {
  if (file.size > MAX_CUSTOM_BYTES) {
    return `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB）——请控制在 2MB 以内`
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read'))
    r.readAsDataURL(file)
  }).catch(() => null)
  if (!dataUrl) return '文件读取失败'
  const dur = await probeDuration(dataUrl)
  if (!(dur > 0)) return '无法读取音频（格式不受支持，请换 MP4 等常见格式）'
  if (dur > MAX_CUSTOM_SEC + 0.05) {
    return `音频时长 ${dur.toFixed(1)} 秒，超过 ${MAX_CUSTOM_SEC} 秒上限——请裁剪后再上传`
  }
  updateSoundPrefs({ customData: dataUrl, customName: file.name })
  return null
}
