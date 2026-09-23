/**
 * 右下角黑胶音乐播放器（样式 1:1 复刻 音乐播放.md，主题仅适配卡片容器配色）：
 *  - 收起态：160×80 小卡 + 上方探出的 128px 黑胶（svg 溢出容器、下半藏在卡后，露上半）；
 *  - hover：卡片长到 288×160，把上方大盘整个盖住；卡头同时探出 96px 小盘 + 歌名滑出；
 *  - 原稿细节全保留：唱片永远旋转（svg 自转）、白色唱芯是容器上的独立元素（不转）、
 *    两侧按钮（播放模式/列表）宽度从 0 展开、时间数字 hover 才出现、进度行内嵌在圆角槽里；
 *  - 唯一修正：控制钮间距用按钮自身 margin 实现（原稿 space-x-5 在收起态会撑爆 160px 卡片）。
 *
 * 曲源：music/nowPlaying.ts 单例 store —— 仅平台点播；音乐源未配置或未登录时
 * 不渲染播放器（不提供默认/示例歌单），配置并登录后出现，可搜索点播。
 */
import { useEffect, useRef, useState } from 'react'
import {
  playPlatformSong,
  seek,
  searchPlatform,
  setShuffle,
  setVolume,
  togglePlay,
  next as nextTrack,
  useNowPlaying,
} from './nowPlaying.ts'
import type { MusicSearchSong } from '../api.ts'

const fmt = (s: number): string => {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// ── 应用内搜索历史（localStorage；点词快速重搜）──
const HIST_KEY = 'ss-music-search-history'
function loadSearchHistory(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 8) : []
  } catch {
    return []
  }
}
function pushSearchHistory(kw: string): string[] {
  const next = [kw, ...loadSearchHistory().filter((x) => x !== kw)].slice(0, 8)
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式等场景存不进就算了 */
  }
  return next
}

/** 黑胶唱片（原稿矢量原样：黑底 + 白噪点 + 高光斑 + 紫色声波；spinning 控制 svg 自转） */
function Vinyl({ size, spinning, className = '' }: { size: number; spinning: boolean; className?: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={`mp-disc${spinning ? ' spinning' : ''} ${className}`}
      aria-hidden
    >
      <rect width="128" height="128" fill="#000" />
      <circle cx="20" cy="20" r="2" fill="#fff" />
      <circle cx="40" cy="30" r="2" fill="#fff" />
      <circle cx="60" cy="10" r="2" fill="#fff" />
      <circle cx="80" cy="40" r="2" fill="#fff" />
      <circle cx="100" cy="20" r="2" fill="#fff" />
      <circle cx="120" cy="50" r="2" fill="#fff" />
      <circle cx="90" cy="30" r="10" fill="#fff" fillOpacity="0.5" />
      <circle cx="90" cy="30" r="8" fill="#fff" />
      <path d="M0 128 Q32 64 64 128 T128 128" fill="#800080" stroke="#000" strokeWidth="1" />
      <path d="M0 128 Q32 48 64 128 T128 128" fill="#9370db" stroke="#000" strokeWidth="1" />
      <path d="M0 128 Q32 32 64 128 T128 128" fill="#663399" stroke="#000" strokeWidth="1" />
      <path d="M0 128 Q16 64 32 128 T64 128" fill="#800080" stroke="#000" strokeWidth="1" />
      <path d="M64 128 Q80 64 96 128 T128 128" fill="#9370db" stroke="#000" strokeWidth="1" />
    </svg>
  )
}

/** 歌单浮层：顶部搜索框（点播 + 最近搜索词），下方依次列我喜欢的/最近在听/搜索结果 */
function PlaylistPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const np = useNowPlaying()
  const personal = np.personal
  const [kw, setKw] = useState('')
  const [results, setResults] = useState<MusicSearchSong[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [hist, setHist] = useState<string[]>(loadSearchHistory)

  const runSearch = async (q: string): Promise<void> => {
    if (!q || busy) return
    setBusy(true)
    setSearchErr('')
    try {
      setResults(await searchPlatform(q))
      setHist(pushSearchHistory(q))
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e))
      setResults(null)
    } finally {
      setBusy(false)
    }
  }

  const pickPlatform = (song: MusicSearchSong, queue?: MusicSearchSong[]): void => {
    void playPlatformSong(song, queue)
    onClose()
  }

  const songBtn = (s: MusicSearchSong, queue?: MusicSearchSong[]): React.JSX.Element => {
    const on = np.track?.id === s.id
    return (
      <button key={s.id} type="button" role="option" aria-selected={on} className={on ? 'on' : ''} onClick={() => pickPlatform(s, queue)}>
        <span className="mp-list-name">{s.name}</span>
        <span className="mp-list-artist">{s.artist}</span>
      </button>
    )
  }

  return (
    <div className="mp-list" role="listbox" aria-label="播放列表">
      <div className="mp-search">
        <input
          value={kw}
          placeholder={`搜索${np.music?.platform === 'qq' ? 'QQ 音乐' : '网易云'}曲目，回车点播`}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch(kw.trim())
          }}
        />
        <button type="button" disabled={busy || !kw.trim()} onClick={() => void runSearch(kw.trim())}>
          {busy ? '搜索中' : '搜索'}
        </button>
      </div>
      {!kw && results === null && hist.length > 0 && (
        <div className="mp-hist">
          <span className="mp-hist-label">最近搜索</span>
          {hist.map((h) => (
            <button key={h} type="button" onClick={() => { setKw(h); void runSearch(h) }}>
              {h}
            </button>
          ))}
        </div>
      )}
      {searchErr && <div className="mp-list-note bad">{searchErr}</div>}
      {results && (
        <>
          <div className="mp-list-head">搜索结果 · 点击播放</div>
          {results.length === 0 && <div className="mp-list-note">没有找到相关曲目</div>}
          {results.map((s) => songBtn(s, results))}
        </>
      )}
      {results === null && personal?.liked?.length ? (
        <>
          <div className="mp-list-head">我喜欢的 · 点击播放</div>
          {personal.liked.map((s) => songBtn(s, personal.liked))}
        </>
      ) : null}
      {results === null && personal?.recent?.length ? (
        <>
          <div className="mp-list-head">最近在听 · 点击播放</div>
          {personal.recent.map((s) => songBtn(s, personal.recent))}
        </>
      ) : null}
      {results === null && !personal?.liked?.length && !personal?.recent?.length && (
        <div className="mp-list-note">搜索点播一首试试；你喜欢的歌曲和最近在听会显示在这里</div>
      )}
      <div className="mp-vol">
        <span>音量</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(np.volume * 100)}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          aria-label="音量"
        />
      </div>
    </div>
  )
}

export function MusicPlayer({ onListOpenChange }: { onListOpenChange?: (open: boolean) => void } = {}): React.JSX.Element | null {
  const np = useNowPlaying()
  const rootRef = useRef<HTMLDivElement>(null)
  const [listOpen, setListOpen] = useState(false)
  /** 播放器窗口置顶（桌面壳 alwaysOnTop；纯浏览器无此能力隐藏按钮）。
   *  置顶是窗口级高危状态：不跨会话持久化（重启/刷新后回到常规层级，防误触后无从取消）；
   *  音乐源未解锁（未配置/登录失效）时强制取消——播放器 UI 消失后钉子入口随之消失，
   *  不取消会死锁在「窗口永远置顶、无处可关」（切屏也无法脱离） */
  const canPin = typeof window !== 'undefined' && !!window.storyDesktop?.setAlwaysOnTop
  const [onTop, setOnTop] = useState(false)
  useEffect(() => {
    void window.storyDesktop?.setAlwaysOnTop?.(onTop)
  }, [onTop])
  // unlocked 定义在下方（hooks 之后早退 return null 前）——此处先声明引用
  const unlockedRef = useRef(false)

  // 弹层开合上报：桌面端原生浏览器视图永远在 DOM 之上，App 据此隐藏原生视图避免盖住弹层
  useEffect(() => {
    onListOpenChange?.(listOpen)
  }, [listOpen, onListOpenChange])

  // 歌单浮层：点外部 / Esc 关闭（音乐不停）
  useEffect(() => {
    if (!listOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setListOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setListOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [listOpen])

  // 未配置音乐源或未登录：不提供任何默认/示例歌单，播放功能整体不可用（顶栏右岛引导去设置）。
  // 早退放在 hooks 之后（hook 数量须恒定）
  const unlocked = np.music?.configured === true && np.music?.loggedIn === true
  // 未解锁时强制退出置顶：早退后钉子按钮不再渲染，窗口若仍 alwaysOnTop 将无处可关
  //（unlockedRef 让下方 effect 引用最新值，避免把 unlocked 加进上方置顶 effect 的依赖）
  unlockedRef.current = unlocked
  useEffect(() => {
    if (!unlockedRef.current && onTop) setOnTop(false)
  }, [onTop, unlocked])
  if (!unlocked) return null

  const artist = np.err ? np.errText || '播放失败，试试下一首' : (np.track?.artist ?? '从播放列表点播一首')

  return (
    <div ref={rootRef} className={`mp-root${listOpen ? ' pinned' : ''}${onTop ? ' mini' : ''}`}>
      {listOpen && <PlaylistPanel onClose={() => setListOpen(false)} />}

      {/* 上方大黑胶：128px svg 溢出 64px 容器，下半藏在卡片后；hover 时被升起的卡片盖住 */}
      <div className="mp-disc-top" aria-hidden>
        <Vinyl size={128} spinning className="mp-disc-big" />
        {/* 白色唱芯：独立元素不随唱片旋转（原稿细节） */}
        <i className="mp-hole mp-hole-big" />
      </div>

      {/* 控制卡：收起 160×80，hover 展开 288×160 并盖住上方大盘 */}
      <div className="mp-card">
        {/* 置顶图钉：常驻右上方；置顶=播放器缩为只剩钉子悬浮（窗口 alwaysOnTop），再点恢复+置于下层 */}
        <button
          type="button"
          className={`mp-pin${onTop ? ' on' : ''}`}
          title={canPin ? (onTop ? '置于下层（恢复播放器）' : '窗口置顶（缩为钉子）') : '窗口置顶（桌面版可用）'}
          onClick={() => {
            setListOpen(false)
            if (canPin) setOnTop((v) => !v)
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={onTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
          </svg>
        </button>
        {/* 卡头：小黑胶从卡顶探出 + 歌名/歌手滑出（收起时高度为 0） */}
        <div className="mp-head">
          <div className="mp-head-disc" aria-hidden>
            <Vinyl size={96} spinning className="mp-disc-small" />
            <i className="mp-hole mp-hole-small" />
          </div>
          <div className="mp-meta">
            <p className="mp-name">{np.track?.name ?? '尚未播放'}</p>
            <p className="mp-artist">{artist}</p>
          </div>
        </div>

        {/* 进度行：圆角槽内嵌进度条，时间数字仅 hover 展示 */}
        <div className="mp-progress">
          <span className="mp-time">{fmt(np.cur)}</span>
          <input
            type="range"
            className="mp-seek"
            min={0}
            max={np.dur > 0 ? Math.floor(np.dur) : 0}
            value={Math.floor(np.cur)}
            style={{ '--fill': `${np.dur > 0 ? (np.cur / np.dur) * 100 : 0}%` } as React.CSSProperties}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="播放进度"
          />
          <span className="mp-time">{fmt(np.dur)}</span>
        </div>

        {/* 控制行：两侧按钮（播放模式/列表）宽度从 0 展开，中间三钮常驻 */}
        <div className="mp-ctrl">
          <button
            type="button"
            className="mp-btn mp-btn-fold"
            title={np.shuffle ? '随机播放' : '顺序播放'}
            onClick={() => setShuffle(!np.shuffle)}
          >
            {np.shuffle ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 3 21 3 21 8" />
                <line x1="4" y1="20" x2="21" y2="3" />
                <polyline points="21 16 21 21 16 21" />
                <line x1="15" y1="15" x2="21" y2="21" />
                <line x1="4" y1="4" x2="9" y2="9" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            )}
          </button>
          <button type="button" className="mp-btn" title="上一曲" onClick={() => void nextTrack(-1)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="19 20 9 12 19 4 19 20" />
              <line x1="5" y1="19" x2="5" y2="5" />
            </svg>
          </button>
          <button type="button" className="mp-btn" title={np.playing ? '暂停' : '播放'} onClick={togglePlay}>
            {np.playing ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
          </button>
          <button type="button" className="mp-btn" title="下一曲" onClick={() => void nextTrack(1)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 4 15 12 5 20 5 4" />
              <line x1="19" y1="5" x2="19" y2="19" />
            </svg>
          </button>
          <button
            type="button"
            className={`mp-btn mp-btn-fold${listOpen ? ' on' : ''}`}
            title="播放列表"
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
