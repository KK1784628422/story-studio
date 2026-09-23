/**
 * 音乐状态源（模块级单例，跨组件存活）：
 *  - 右下角 MusicPlayer（完整播放器）与顶栏右岛（正在播放指示）共享同一份状态；
 *  - 音频元素单例：播放面板关掉音乐不停（码字 BGM）；
 *  - 曲源：仅平台点播（网易云等，/api/music/* 解析直链，见 api.ts）。
 *    未配置音乐源或未登录时不提供任何默认/示例歌单，播放功能整体不可用；
 *  - 订阅：useSyncExternalStore（subscribe/getSnapshot），emit 时重建快照。
 */
import { useSyncExternalStore } from 'react'
import {
  fetchMusicSettings,
  musicLyric,
  musicPersonal,
  musicSearch,
  musicSongUrl,
  type MusicPersonal,
  type MusicSearchSong,
  type MusicSettingsInfo,
} from '../api.ts'

export interface Track {
  /** 平台曲目 id */
  id: string
  name: string
  artist: string
  src: string
}

/** 歌词行（time=秒；tr=中文翻译，可能没有） */
export interface LyricLine {
  time: number
  text: string
  tr?: string
}

/** LRC 文本 → 按时间升序的歌词行；兼容一行多时间标签，跳过无时间标签的元信息行 */
function parseLrc(lrc: string, tr?: string): LyricLine[] {
  const trAt = new Map<number, string>()
  if (tr) {
    for (const line of tr.split(/\r?\n/)) {
      for (const m of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) {
        const text = line.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, '').trim()
        if (text) trAt.set(Number(m[1]) * 60 + Number(m[2]), text)
      }
    }
  }
  const lines: LyricLine[] = []
  for (const line of lrc.split(/\r?\n/)) {
    const tags = Array.from(line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g))
    if (tags.length === 0) continue
    const text = line.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, '').trim()
    if (!text) continue
    for (const m of tags) {
      const time = Number(m[1]) * 60 + Number(m[2])
      const trText = trAt.get(time)
      lines.push(trText ? { time, text, tr: trText } : { time, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

/** 当前时间对应的歌词行下标（time ≤ cur 的最后一行；-1=尚未唱到第一句） */
export function lyricIndexAt(lines: LyricLine[], cur: number): number {
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= cur) idx = i
    else break
  }
  return idx
}

export type PlayMode = 'order' | 'shuffle'

interface NowPlayingState {
  /** 当前曲目（null=尚未点播；不设默认歌单，未登录时播放功能不可用） */
  track: Track | null
  playing: boolean
  cur: number
  dur: number
  err: boolean
  /** 最近一次播放失败的原因（平台点播解析失败等） */
  errText: string
  shuffle: boolean
  /** 音量 0~1 */
  volume: number
  /** 音乐源配置（启动时异步拉取；未配置时右岛引导去设置） */
  music: MusicSettingsInfo | null
  /** 个人化列表（我喜欢的/最近在听；已配置且登录成功后才有数据） */
  personal: MusicPersonal | null
  /** 当前曲目的歌词行（点播时异步拉取；无歌词/拉取失败为 null） */
  lyric: LyricLine[] | null
  /** 平台播放队列（从「我喜欢的/最近在听/搜索结果」点播时带入，播完自动下一首） */
  queue: MusicSearchSong[]
  /** 当前曲目在 queue 中的下标 */
  queueIdx: number
}

// ── 音频单例 ──
let audioEl: HTMLAudioElement | null = null
function getAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio()
    audioEl.preload = 'metadata'
  }
  return audioEl
}

const state: NowPlayingState = (() => {
  const a = getAudioEl()
  return {
    track: null,
    playing: a.src !== '' && !a.paused && !a.ended,
    cur: a.currentTime,
    dur: a.duration || 0,
    err: false,
    errText: '',
    shuffle: false,
    volume: 1,
    music: null,
    personal: null,
    lyric: null,
    queue: [],
    queueIdx: -1,
  }
})()

// ── pub/sub ──
const listeners = new Set<() => void>()
let snapshot: NowPlayingState = { ...state }
function emit(): void {
  snapshot = { ...state }
  listeners.forEach((fn) => fn())
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function useNowPlaying(): NowPlayingState {
  return useSyncExternalStore(subscribe, () => snapshot)
}

// ── 音频事件接线（模块加载时挂一次）──
function wireAudio(): void {
  const a = getAudioEl()
  a.addEventListener('timeupdate', () => {
    state.cur = a.currentTime
    emit()
  })
  a.addEventListener('loadedmetadata', () => {
    state.dur = a.duration || 0
    state.err = false
    emit()
  })
  a.addEventListener('play', () => {
    state.playing = true
    emit()
  })
  a.addEventListener('pause', () => {
    state.playing = false
    emit()
  })
  a.addEventListener('ended', () => {
    // 平台曲目在点播队列内轮换（单曲点播队列长 1 → 播完即停）
    void advanceQueue(1)
  })
  a.addEventListener('error', () => {
    state.err = true
    state.playing = false
    emit()
  })
  a.addEventListener('volumechange', () => {
    state.volume = a.volume
    emit()
  })
}
wireAudio()

// ── 动作 ──

function togglePlay(): void {
  if (!state.track) return
  const a = getAudioEl()
  if (!a.src) a.src = state.track.src
  if (a.paused) {
    void a.play().catch(() => {
      state.err = true
      emit()
    })
  } else {
    a.pause()
  }
}

function seek(v: number): void {
  if (!state.track) return
  const a = getAudioEl()
  a.currentTime = v
  state.cur = v
  emit()
}

function setVolume(v: number): void {
  getAudioEl().volume = Math.min(1, Math.max(0, v))
}

function setShuffle(on: boolean): void {
  state.shuffle = on
  emit()
}

/** 拉当前曲目歌词（点播后异步调；曲已切走则丢弃，失败静默保持无歌词） */
async function loadLyric(id: string): Promise<void> {
  try {
    const { lyric, tlyric } = await musicLyric(id)
    if (state.track?.id !== id) return
    const lines = parseLrc(lyric, tlyric || undefined)
    state.lyric = lines.length > 0 ? lines : null
    emit()
  } catch {
    /* 无歌词/平台不支持 → 保持 null，顶栏只显示歌名 */
  }
}

/** 点播平台曲目：解析直链 → 换源续播；带 queue 时播完自动在队列内轮换（下一首失败则停） */
async function playPlatformSong(song: MusicSearchSong, queue?: MusicSearchSong[]): Promise<void> {
  state.err = false
  state.lyric = null
  emit()
  try {
    const url = await musicSongUrl(song.id)
    state.track = { id: song.id, name: song.name, artist: song.artist, src: url }
    state.queue = queue && queue.length > 0 ? queue : [song]
    state.queueIdx = Math.max(0, state.queue.findIndex((s) => s.id === song.id))
    state.cur = 0
    state.dur = 0
    const a = getAudioEl()
    a.src = url
    a.currentTime = 0
    void loadLyric(song.id)
    await a.play()
  } catch (e) {
    state.err = true
    state.playing = false
    state.errText = e instanceof Error ? e.message : String(e)
    emit()
  }
}

/** 队列内切曲（上一曲/下一曲/播完自动）：解析直链失败时停在原曲并提示（不静默循环跳曲） */
async function advanceQueue(offset: number): Promise<void> {
  if (!state.track || state.queue.length < 2) {
    emit()
    return
  }
  const n = (state.queueIdx + offset + state.queue.length) % state.queue.length
  await playPlatformSong(state.queue[n], state.queue)
}

/** 平台搜索（MusicPlayer 歌单浮层用；调用方自理 loading/error 展示） */
async function searchPlatform(keywords: string): Promise<MusicSearchSong[]> {
  return musicSearch(keywords)
}

/** 拉取音乐源配置（App 挂载时调一次；设置页保存/登录后也调，右岛即时感知）；
 *  已配置时顺带拉个人化列表（我喜欢的/最近在听），失败静默（浮层内仍可搜索点播）。
 *  in-flight 去重：React StrictMode 开发态双挂载会连调两次，共享同一次请求避免翻倍打解析 API */
let refreshInFlight: Promise<void> | null = null
async function refreshMusicConfig(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      state.music = await fetchMusicSettings()
    } catch {
      state.music = { configured: false, platform: 'netease', apiBase: '', loggedIn: false }
    }
    state.personal = state.music.configured ? await musicPersonal().catch(() => null) : null
    refreshInFlight = null
    emit()
  })()
  return refreshInFlight
}

export {
  advanceQueue as next,
  togglePlay,
  seek,
  setVolume,
  setShuffle,
  playPlatformSong,
  searchPlatform,
  refreshMusicConfig,
  useNowPlaying,
}
export type { NowPlayingState }
