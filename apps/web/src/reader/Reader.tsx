/**
 * 手机仿真阅读器（novel-reader Reader.tsx 移植 + Story Studio 适配）：
 * 分页翻页 / 单击翻页双击朗读 / TTS 连播（页间/章间自动续）+ 预取 + 逐句高亮
 * / 显示页与朗读页解耦 / 三主题字号 / 右键正文锚点跳编辑器 / 外部章节跳转（跟随 Agent）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterBrief } from '@story-studio/shared'
import { fetchChapter, ttsUrl } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { paginate, splitLineBySentences, type PagedChapter } from './pager.ts'
import { TocDrawer } from './TocDrawer.tsx'
import { VoicePanel } from './VoicePanel.tsx'

interface Props {
  bookTitle: string
  chapters: ChapterBrief[]
  /** 当前章节（受控：目录/翻章/跟随 Agent 均经由父级） */
  chapterIdx: number
  onChapterChange: (idx: number) => void
  /** 每次自增触发当前章重新加载（编辑器同步后刷新） */
  reloadSignal?: number
  /** 手机屏内右键正文某处时，把该处文本锚点交给编辑器定位 */
  onEditorJump?: (anchor: string) => void
  /** 编辑器开合（受控于 WorkPanel：底部「编辑器」tab 与外部按钮同一状态） */
  editorOpen?: boolean
  onToggleEditor?: () => void
}

/** 音色 + pitch 预设：Edge 免费接口不支持风格标注，语气感靠音调抬高和原生戏感音色 */
export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', pitch: '+15%', label: '晓晓 · 元气' },
  { id: 'zh-CN-XiaoxiaoNeural', pitch: '+0%', label: '晓晓 · 标准' },
  { id: 'zh-CN-XiaoyiNeural', pitch: '+10%', label: '晓伊 · 活泼' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', pitch: '+5%', label: '晓北 · 东北味' },
  { id: 'zh-CN-YunxiNeural', pitch: '+10%', label: '云希 · 热血少年' },
  { id: 'zh-CN-YunjianNeural', pitch: '+0%', label: '云健 · 说书人' },
]

export const RATES = [
  { label: '0.75x', value: '-25%' },
  { label: '1.0x', value: '+0%' },
  { label: '1.25x', value: '+25%' },
  { label: '1.5x', value: '+50%' },
]

type SpeechState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

const PROGRESS_KEY = 'ss.reader.progress'
const VOICE_KEY = 'ss.reader.voice'
const RATE_KEY = 'ss.reader.rate'
const FONT_KEY = 'ss.reader.font'
const THEME_KEY = 'ss.reader.theme'

export const FONT_MIN = 12
export const FONT_MAX = 26
export const FONT_DEFAULT = 17

export const THEMES = [
  { id: 'light', label: '默认' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '黑夜' },
] as const
type ThemeId = (typeof THEMES)[number]['id']

/** 朗读高亮基准语速：1x 时约 4.2 字/秒（估算逐句高亮节奏） */
const CHARS_PER_SEC = 4.2
const RATE_FACTOR: Record<string, number> = { '-25%': 0.75, '+0%': 1, '+25%': 1.25, '+50%': 1.5 }

function sentenceDurationMs(text: string, rate: string): number {
  const factor = RATE_FACTOR[rate] ?? 1
  return (text.length * 1000) / (CHARS_PER_SEC * factor)
}

export function Reader({
  bookTitle,
  chapters,
  chapterIdx,
  onChapterChange,
  reloadSignal = 0,
  onEditorJump,
  editorOpen = false,
  onToggleEditor,
}: Props) {
  const [paged, setPaged] = useState<PagedChapter | null>(null)
  const [page, setPage] = useState(0)
  const [speechPage, setSpeechPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tocOpen, setTocOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 章滑杆拖动中的预览值（null=未拖动，松手才真正跳章） */
  const [scrubIdx, setScrubIdx] = useState<number | null>(null)
  /** 翻页拟真动画（仅章内手动翻页；跨章/自动续播直接切换） */
  const [flip, setFlip] = useState<{ dir: 'next' | 'prev'; from: number; to: number; nonce: number } | null>(null)
  const flippingRef = useRef(false)
  const flipTimerRef = useRef(0)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )

  /** 拟真翻页：底层先渲染目标页，叶面（当前页）绕左缘 3D 翻转；结束后落到目标页 */
  const startFlip = useCallback((dir: 'next' | 'prev', from: number, to: number) => {
    if (reducedMotionRef.current) {
      setPage(to)
      return
    }
    flippingRef.current = true
    setFlip({ dir, from, to, nonce: Date.now() })
    if (flipTimerRef.current) window.clearTimeout(flipTimerRef.current)
    flipTimerRef.current = window.setTimeout(() => {
      flippingRef.current = false
      setFlip(null)
      setPage(to)
    }, 480)
  }, [])

  useEffect(() => () => window.clearTimeout(flipTimerRef.current), [])

  const [voiceKey, setVoiceKey] = useState(
    () => localStorage.getItem(VOICE_KEY) || `${VOICES[0]!.id}|${VOICES[0]!.pitch}`,
  )
  const [rate, setRate] = useState(() => localStorage.getItem(RATE_KEY) || '+0%')
  const [speech, setSpeech] = useState<SpeechState>('idle')
  const [speechDetail, setSpeechDetail] = useState('')
  const [activeSentence, setActiveSentence] = useState(-1)
  const [fontSize, setFontSize] = useState<number>(() => {
    const n = Number(localStorage.getItem(FONT_KEY))
    return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT
  })
  const [theme, setTheme] = useState<ThemeId>(
    () => (localStorage.getItem(THEME_KEY) as ThemeId) || 'light',
  )

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState({
    fontSize: 17,
    lineHeight: 31,
    charsPerLine: 18,
    letterSpacing: 0,
    linesPerPage: 15,
  })
  const metricsRef = useRef(metrics)

  /**
   * 听书核心状态机：audio 的 ended/error 监听只绑定一次，回调一律从 playbackRef 读最新上下文。
   * page = 显示页码；speechPage = 朗读进度页码（手动翻页不打断朗读）。
   */
  const playbackRef = useRef<{
    paged: PagedChapter | null
    chapters: ChapterBrief[]
    chapterIdx: number
    page: number
    speechPage: number
    listening: boolean
  }>({ paged: null, chapters, chapterIdx, page: 0, speechPage: 0, listening: false })

  const playPageAtRef = useRef<(t: PagedChapter, p: number) => void>(null!)
  const loadChapterRef = useRef<(idx: number, restorePage?: number, autoplay?: boolean) => void>(null!)

  useEffect(() => {
    playbackRef.current = {
      paged,
      chapters,
      chapterIdx,
      page,
      speechPage,
      listening: speech === 'playing' || speech === 'loading' || speech === 'paused',
    }
    playPageAtRef.current = playPageAt
    loadChapterRef.current = loadChapter
  })

  const totalChapters = chapters.length
  const totalPages = paged?.pages.length ?? 1

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  /** 日/夜一键切换：非黑夜 → 黑夜；黑夜 → 回上次浅色主题（设置面板仍可选护眼） */
  const lightMemRef = useRef<ThemeId>('light')
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      if (t === 'dark') return lightMemRef.current
      lightMemRef.current = t
      return 'dark'
    })
  }, [])

  /* ---------- 字号 / 度量（番茄风）：行距 1.8 倍随字号、每页行数按高度自适应、剩余宽摊为字距 ---------- */
  const recalcMetrics = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    // 行容器 .page-lines 自带左右 20px、上下 14px 内边距（14-reader.css）。
    // 旧版直接按外层 .reader-body 全宽估算每行字数，未扣除左右 40px，导致每行被多放了约
    // 两个字，行文本超出内容盒后被 .page-line 的 overflow:hidden 裁掉右端（窄屏更明显）。
    // 优先取真实行容器内容盒度量；未渲染到时按同等内边距兜底。
    const pl = el.querySelector<HTMLElement>('.page-lines')
    const plcs = pl ? getComputedStyle(pl) : null
    const padX = plcs ? parseFloat(plcs.paddingLeft) + parseFloat(plcs.paddingRight) : 40
    const padY = plcs ? parseFloat(plcs.paddingTop) + parseFloat(plcs.paddingBottom) : 28
    const cs = getComputedStyle(el)
    const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - padX
    const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - padY
    if (w <= 0 || h <= 0) return
    const lineHeight = Math.round(fontSize * 1.8)
    const charsPerLine = Math.max(10, Math.floor((w - 2) / fontSize))
    const linesPerPage = Math.max(8, Math.floor((h - 2) / lineHeight))
    // 整行未占满的剩余宽度均摊到每个字（接近两端对齐观感，最大约 1 字宽的 1/行字数）
    const letterSpacing = Math.max(0, (w - 2 - charsPerLine * fontSize) / charsPerLine)
    const next = { fontSize, lineHeight, charsPerLine, letterSpacing, linesPerPage }
    setMetrics(next)
    metricsRef.current = next
  }, [fontSize])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    recalcMetrics()
    const ro = new ResizeObserver(recalcMetrics)
    ro.observe(el)
    return () => ro.disconnect()
  }, [recalcMetrics])

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize))
  }, [fontSize])

  // 版面键（每行字数×每页行数）变化（调字号/开合编辑器/窗口缩放）→ 重新分页当前章并保持页码；
  // 修复旧版：尺寸变化不重排 → 行宽与版面不一致导致文字被裁
  const layoutKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${metrics.charsPerLine}x${metrics.linesPerPage}`
    if (layoutKeyRef.current === null) {
      layoutKeyRef.current = key
      return
    }
    if (layoutKeyRef.current === key || !paged || loading) return
    layoutKeyRef.current = key
    loadChapter(chapterIdx, playbackRef.current.page, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics])

  /* ---------- 进度记忆 ---------- */
  useEffect(() => {
    if (paged && !loading) {
      localStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({ chapter: chapterIdx, page, updatedAt: Date.now() }),
      )
    }
  }, [paged, loading, chapterIdx, page])

  /* ---------- 音频实例（只创建一次，监听只绑一次） ---------- */
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current
    const audio = new Audio()
    audio.preload = 'auto'
    audio.addEventListener('playing', () => setSpeech('playing'))
    audio.addEventListener('error', async () => {
      let detail = ''
      try {
        const res = await fetch(audio.src ?? '')
        if (!res.ok) detail = (await res.text()).replace(/^语音合成失败[^:]*:\s*/, '').slice(0, 110)
      } catch {
        // 保留默认文案
      }
      setSpeechDetail(detail)
      setSpeech('error')
    })
    audio.addEventListener('ended', () => {
      const s = playbackRef.current
      if (!s.paged) return
      if (s.speechPage < s.paged.pages.length - 1) {
        const np = s.speechPage + 1
        setPage(np)
        playPageAtRef.current(s.paged, np)
      } else {
        const next = s.chapters.find((c) => c.index === s.chapterIdx + 1)
        if (next) loadChapterRef.current(next.index, 0, true)
        else setSpeech('idle')
      }
    })
    audioRef.current = audio
    return audio
  }, [])

  /* ---------- 播放某章某页（显式传 paged，不依赖渲染闭包） ---------- */
  const playPageAt = useCallback(
    (target: PagedChapter, p: number) => {
      const text = target.pageTexts[p]
      if (!text) return
      setSpeechPage(p)
      setActiveSentence(0)
      setSpeechDetail('')
      setSpeech('loading')
      const audio = ensureAudio()
      const [voiceId, voicePitch] = voiceKey.split('|')
      audio.src = ttsUrl(text, voiceId ?? 'zh-CN-XiaoxiaoNeural', rate, voicePitch ?? '+0%')
      audio
        .play()
        .then(() => setSpeech('playing'))
        .catch(() => setSpeech('error'))
    },
    [voiceKey, rate, ensureAudio],
  )

  /* ---------- 章节加载 ---------- */
  const loadChapter = useCallback(
    (idx: number, restorePage?: number, autoplay = false) => {
      // 章节切换时取消进行中的翻页动画（防过期定时器回落到旧页码）
      if (flipTimerRef.current) {
        window.clearTimeout(flipTimerRef.current)
        flipTimerRef.current = 0
      }
      flippingRef.current = false
      setFlip(null)
      setLoading(true)
      setError('')
      fetchChapter(idx)
        .then((c) => {
          const result = paginate(c.markdown, {
            charsPerLine: metricsRef.current.charsPerLine,
            linesPerPage: metricsRef.current.linesPerPage,
          })
          onChapterChange(idx)
          setPaged(result)
          const maxPage = Math.max(0, result.pages.length - 1)
          const target = restorePage != null ? Math.min(restorePage, maxPage) : 0
          setPage(target)
          setSpeechPage(target)
          setLoading(false)
          if (autoplay) playPageAt(result, target)
        })
        .catch((e: Error) => {
          setError(String(e.message || e))
          setLoading(false)
        })
    },
    [onChapterChange, playPageAt],
  )

  const loadedIdxRef = useRef(-1)
  useEffect(() => {
    loadChapter(chapterIdx)
    loadedIdxRef.current = chapterIdx
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部章节跳转（目录之外：跟随 Agent / 编辑器联动）：chapterIdx prop 变化时加载
  useEffect(() => {
    if (chapterIdx !== loadedIdxRef.current) {
      loadedIdxRef.current = chapterIdx
      loadChapter(chapterIdx)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIdx])

  // 编辑器同步后：重新加载当前章（保持当前页码）
  useEffect(() => {
    if (reloadSignal === 0) return
    loadChapter(chapterIdx, playbackRef.current.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal])

  /* ---------- 听书控制 ---------- */
  const stopSpeech = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setSpeech('idle')
    setSpeechDetail('')
    setActiveSentence(-1)
  }, [])

  const toggleSpeech = useCallback(() => {
    if (speech === 'idle' || speech === 'error') {
      if (paged) playPageAt(paged, speechPage)
    } else if (speech === 'playing' || speech === 'loading') {
      audioRef.current?.pause()
      setSpeech('paused')
    } else if (speech === 'paused') {
      const audio = ensureAudio()
      audio
        .play()
        .then(() => setSpeech('playing'))
        .catch(() => setSpeech('error'))
    }
  }, [speech, paged, speechPage, playPageAt, ensureAudio])

  const listeningRef = useRef(false)
  useEffect(() => {
    listeningRef.current = speech === 'playing' || speech === 'loading' || speech === 'paused'
  }, [speech])

  /** 双击屏幕：从当前显示页开始朗读 */
  const readFromCurrentPage = useCallback(() => {
    if (!paged) return
    setSpeechPage(page)
    playPageAt(paged, page)
  }, [paged, page, playPageAt])

  /** 听书统一入口：未开始/出错 → 先打开音色面板选择；进行中 → 暂停/继续 */
  const requestListen = useCallback(() => {
    if (!paged) return
    if (speech === 'idle' || speech === 'error') {
      setVoiceOpen(true)
      return
    }
    toggleSpeech()
  }, [paged, speech, toggleSpeech])

  // 播放中预取下一页音频
  useEffect(() => {
    if (listeningRef.current && paged && speechPage < paged.pages.length - 1) {
      const [voiceId, voicePitch] = voiceKey.split('|')
      const preloader = new Audio()
      preloader.preload = 'auto'
      preloader.src = ttsUrl(
        paged.pageTexts[speechPage + 1] ?? '',
        voiceId ?? 'zh-CN-XiaoxiaoNeural',
        rate,
        voicePitch ?? '+0%',
      )
    }
  }, [speech, speechPage, paged, voiceKey, rate])

  // 音色/语速切换后：正在听书则重播「朗读进度」页
  useEffect(() => {
    if (speech !== 'idle' && speech !== 'error' && paged) playPageAt(paged, speechPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceKey, rate])

  // 合成偶发失败时 4 秒后自动重试一次
  const autoRetriedRef = useRef(false)
  useEffect(() => {
    if (speech !== 'error') {
      if (speech === 'idle') autoRetriedRef.current = false
      return
    }
    if (autoRetriedRef.current) return
    autoRetriedRef.current = true
    const t = setTimeout(() => {
      if (paged) playPageAt(paged, speechPage)
    }, 4000)
    return () => clearTimeout(t)
  }, [speech, speechPage, paged, playPageAt])

  useEffect(() => stopSpeech, [stopSpeech])

  /* ---------- 逐句高亮：按朗读时间推进当前句子 ---------- */
  useEffect(() => {
    if (speech !== 'playing' || !paged || page !== speechPage) {
      setActiveSentence(-1)
      return
    }
    const audio = audioRef.current
    if (!audio) return
    const sentences = paged.pageSentences[page]
    if (!sentences || sentences.length === 0) return
    const durs = sentences.map((s) => sentenceDurationMs(s.text, rate))
    let last = -1
    const timer = window.setInterval(() => {
      const t = audio.currentTime * 1000
      let acc = 0
      let idx = sentences.length - 1
      for (let i = 0; i < durs.length; i++) {
        acc += durs[i]!
        if (t < acc) {
          idx = i
          break
        }
      }
      if (idx !== last) {
        last = idx
        setActiveSentence(idx)
      }
    }, 150)
    return () => {
      clearInterval(timer)
      setActiveSentence(-1)
    }
  }, [speech, page, speechPage, paged, rate])

  /* ---------- 翻页 / 翻章（手动翻页不打断朗读；章内翻页带拟真动画） ---------- */
  const nextPage = useCallback(() => {
    if (flippingRef.current) return
    if (page < totalPages - 1) {
      startFlip('next', page, page + 1)
      return
    }
    const next = chapters.find((c) => c.index === chapterIdx + 1)
    if (next) loadChapter(next.index, 0, listeningRef.current)
  }, [page, totalPages, chapters, chapterIdx, loadChapter, startFlip])

  const prevPage = useCallback(() => {
    if (flippingRef.current) return
    if (page > 0) {
      startFlip('prev', page, page - 1)
      return
    }
    const prev = chapters.find((c) => c.index === chapterIdx - 1)
    if (prev) loadChapter(prev.index, 9999, listeningRef.current)
  }, [page, chapters, chapterIdx, loadChapter, startFlip])

  const nextChapter = useCallback(() => {
    const next = chapters.find((c) => c.index === chapterIdx + 1)
    if (next) loadChapter(next.index, 0, listeningRef.current)
  }, [chapters, chapterIdx, loadChapter])

  const prevChapter = useCallback(() => {
    const prev = chapters.find((c) => c.index === chapterIdx - 1)
    if (prev) loadChapter(prev.index, 0, listeningRef.current)
  }, [chapters, chapterIdx, loadChapter])

  const jumpChapter = useCallback(
    (idx: number) => {
      setTocOpen(false)
      if (idx === chapterIdx) return
      loadChapter(idx, 0, listeningRef.current)
    },
    [chapterIdx, loadChapter],
  )

  /** 章滑杆松手提交：跳到预览章节 */
  const commitScrub = useCallback(() => {
    if (scrubIdx == null) return
    const idx = scrubIdx
    setScrubIdx(null)
    if (idx === chapterIdx) return
    loadChapter(idx, 0, listeningRef.current)
  }, [scrubIdx, chapterIdx, loadChapter])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tocOpen || voiceOpen || settingsOpen) {
        if (e.key === 'Escape') {
          setTocOpen(false)
          setVoiceOpen(false)
          setSettingsOpen(false)
        }
        return
      }
      if (e.key === 'ArrowRight') nextPage()
      else if (e.key === 'ArrowLeft') prevPage()
      else if (e.key === 'ArrowDown' || e.key === 'PageDown') nextChapter()
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') prevChapter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nextPage, prevPage, nextChapter, prevChapter, tocOpen, voiceOpen, settingsOpen])

  /** 章滑杆拖动预览的目标章标题 */
  const scrubTitle = useMemo(
    () => (scrubIdx != null ? (chapters.find((c) => c.index === scrubIdx)?.title ?? '') : ''),
    [scrubIdx, chapters],
  )

  /* ---------- 单击 / 双击 区分 ---------- */
  const clickTimerRef = useRef<number>(0)
  const lastClickRef = useRef(0)
  /** 在事件同步阶段读取坐标（React 合成事件的 currentTarget 在异步回调里为 null） */
  const doTurnByTap = (rect: DOMRect, clientX: number) => {
    const x = clientX - rect.left
    if (x < rect.width * 0.33) prevPage()
    else if (x > rect.width * 0.67) nextPage()
    else {
      // 中间点击：呼出/收起目录（功能区保持常驻）
      setVoiceOpen(false)
      setSettingsOpen(false)
      setTocOpen((v) => !v)
    }
  }
  const handleBodyClick = (e: React.MouseEvent) => {
    const now = Date.now()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const { clientX } = e
    if (now - lastClickRef.current < 300) {
      window.clearTimeout(clickTimerRef.current)
      return
    }
    lastClickRef.current = now
    window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = window.setTimeout(() => doTurnByTap(rect, clientX), 250)
  }
  const handleBodyDoubleClick = () => {
    window.clearTimeout(clickTimerRef.current)
    // 与听书入口一致：未开始时先选音色；进行中从当前显示页重新朗读
    if (speech === 'idle' || speech === 'error') {
      setVoiceOpen(true)
      return
    }
    readFromCurrentPage()
  }

  /** 右键某个正文位置 → 把该处文本锚点交给编辑器定位 */
  const handleBodyContextMenu = (e: React.MouseEvent) => {
    if (!onEditorJump || !paged) return
    e.preventDefault()
    const lineEl = (e.target as HTMLElement).closest('.page-line') as HTMLElement | null
    if (!lineEl) return
    const text = (lineEl.dataset.text || '').trim()
    if (!text) return
    const sel = window.getSelection?.()
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    let offset = 0
    if (range && lineEl.contains(range.startContainer)) {
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
      let acc = 0
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          acc += range.startOffset
          break
        }
        acc += node.textContent?.length ?? 0
      }
      offset = acc
      sel?.removeAllRanges()
    }
    const start = Math.max(0, offset - 2)
    const anchor = text.slice(start, start + 22).replace(/\s+/g, ' ').trim()
    if (anchor) onEditorJump(anchor)
  }

  // 每行在本页拼接串中的起始偏移（逐句高亮定位用）
  const lineOffsets = useMemo(() => {
    if (!paged) return []
    const offs: number[] = []
    let acc = 0
    for (const line of paged.pages[page] ?? []) {
      offs.push(acc)
      acc += line.text.length
    }
    return offs
  }, [paged, page])

  const highlit =
    speech === 'playing' && paged !== null && page === speechPage && activeSentence >= 0

  const speechLabel =
    speech === 'loading'
      ? '缓冲中'
      : speech === 'playing'
        ? '朗读中'
        : speech === 'paused'
          ? '已暂停'
          : speech === 'error'
            ? '朗读失败'
            : '听书'

  const showSpeechRow =
    speech === 'playing' || speech === 'loading' || speech === 'paused' || speech === 'error'

  /** 渲染某页行内容；plain=true（翻页叶面）不做逐句高亮拆分 */
  const renderPageLines = (idx: number, plain = false) => {
    if (!paged) return null
    return (
      <div
        className="page-lines"
        style={{
          fontSize: metrics.fontSize,
          lineHeight: `${metrics.lineHeight}px`,
          letterSpacing: `${metrics.letterSpacing.toFixed(2)}px`,
        }}
      >
        {(paged.pages[idx] ?? []).map((line, i) => (
          <div
            key={i}
            data-text={line.text}
            className={`page-line${line.center ? ' center' : ''}${line.paraStart ? ' para' : ''}`}
          >
            {!plain && highlit && idx === page
              ? splitLineBySentences(
                  line.text,
                  lineOffsets[i] ?? 0,
                  paged.pageSentences[idx] ?? [],
                  activeSentence,
                ).map((seg, j) => (
                  <span key={j} className={seg.active ? 'hl' : undefined}>
                    {seg.text}
                  </span>
                ))
              : line.text}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={`reader theme-${theme}`}>
      <div className="reader-top">
        <button className="rt-btn" onClick={() => setTocOpen(true)} title="目录">
          ☰
        </button>
        <div className="rt-title">
          <div className="rt-book">{bookTitle}</div>
          <div className="rt-chapter">{paged?.title || `第 ${chapterIdx} 章`}</div>
        </div>
        <button
          className={`rt-btn ${showSpeechRow ? 'active' : ''}`}
          onClick={requestListen}
          title={showSpeechRow ? '暂停/继续朗读' : '听书（先选音色）'}
        >
          <Icon name="volume" size={13} /> 听书
        </button>
      </div>

      <div
        className="reader-body"
        ref={bodyRef}
        onClick={handleBodyClick}
        onDoubleClick={handleBodyDoubleClick}
        onContextMenu={handleBodyContextMenu}
      >
        {loading && <div className="reader-loading">正在加载章节…</div>}
        {error && <div className="reader-error">{error}</div>}
        {!loading && !error && paged && (
          flip ? (
            <div key={flip.nonce} className={`flip-scene flip-${flip.dir}`}>
              {/* 底层：next 已露出目标页 / prev 仍是当前页 */}
              <div className="flip-under">
                {renderPageLines(flip.dir === 'next' ? flip.to : flip.from)}
              </div>
              {/* 叶面：next 翻出当前页（0→-180°）/ prev 翻回目标页（-180°→0） */}
              <div className="flip-leaf">
                <div className="flip-face flip-front">
                  {renderPageLines(flip.dir === 'next' ? flip.from : flip.to, true)}
                </div>
                <div className="flip-face flip-back" />
              </div>
            </div>
          ) : (
            renderPageLines(page)
          )
        )}
        {/* 悬浮听书按钮：右下角圆形 FAB，播放控制条出现时让位隐藏；阻止冒泡（否则正文分区会把点击当翻页） */}
        {!showSpeechRow && (
          <button
            type="button"
            className="listen-fab"
            onClick={(e) => {
              e.stopPropagation()
              requestListen()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title="听书 · 选择音色开始"
          >
            听
          </button>
        )}
      </div>

      <div className="reader-bottom">
        {showSpeechRow && (
          <div className="speech-row">
            <span className={`sr-state ${speech}`}>
              {speech === 'error'
                ? speechDetail
                  ? `朗读失败：${speechDetail}`
                  : '朗读失败：需联网访问微软语音服务'
                : `${speechLabel} · 第 ${speechPage + 1} 页`}
            </span>
            <div className="sr-btns">
              {speech === 'error' ? (
                <button className="sr-btn" onClick={toggleSpeech}>
                  ↻ 重试
                </button>
              ) : speech === 'paused' ? (
                <button className="sr-btn primary" onClick={toggleSpeech}>
                  ▶ 继续
                </button>
              ) : (
                <button className="sr-btn primary" onClick={toggleSpeech}>
                  ⏸ 暂停
                </button>
              )}
              <button className="sr-btn" onClick={() => setVoiceOpen(true)}>
                <Icon name="gear" size={12} /> 音色
              </button>
              <button className="sr-btn" onClick={stopSpeech}>
                ⏹ 停止
              </button>
            </div>
          </div>
        )}
        <div className="rb-scrub">
          <button className="rb-chap" onClick={prevChapter} disabled={chapterIdx <= 1}>
            上一章
          </button>
          <input
            type="range"
            className="rb-slider"
            min={1}
            max={Math.max(totalChapters, 1)}
            step={1}
            value={scrubIdx ?? chapterIdx}
            title={scrubTitle ? `跳到：${scrubTitle}` : '拖动选择章节'}
            onChange={(e) => setScrubIdx(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
          />
          <button className="rb-chap" onClick={nextChapter} disabled={chapterIdx >= totalChapters}>
            下一章
          </button>
        </div>
        <div className="rb-tabs">
          <button
            type="button"
            className="rb-tab"
            onClick={() => setTocOpen(true)}
          >
            <Icon name="collection" size={14} /> 目录
          </button>
          <button type="button" className="rb-tab" onClick={toggleTheme}>
            <Icon name="palette" size={14} /> {theme === 'dark' ? '日间' : '夜间'}
          </button>
          <button
            type="button"
            className="rb-tab"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="gear" size={14} /> 设置
          </button>
          <button
            type="button"
            className={`rb-tab${editorOpen ? ' active' : ''}`}
            onClick={onToggleEditor}
            disabled={!onToggleEditor}
          >
            <Icon name="pencil" size={14} /> 编辑器
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="settings-panel">
          <div className="settings-head">
            <h3>阅读设置</h3>
            <button className="drawer-close" onClick={() => setSettingsOpen(false)}>
              ✕
            </button>
          </div>
          <div className="vp-section">
            <h3>字号</h3>
            <div className="font-stepper">
              <button
                className="fs-btn"
                onClick={() => setFontSize((f) => Math.max(FONT_MIN, f - 1))}
                disabled={fontSize <= FONT_MIN}
              >
                －
              </button>
              <input
                type="range"
                className="fs-range"
                min={FONT_MIN}
                max={FONT_MAX}
                step={1}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
              <button
                className="fs-btn"
                onClick={() => setFontSize((f) => Math.min(FONT_MAX, f + 1))}
                disabled={fontSize >= FONT_MAX}
              >
                ＋
              </button>
              <span className="fs-value">{fontSize}px</span>
            </div>
            <div className="fs-scale">
              <span>{FONT_MIN}</span>
              <span>{FONT_MAX}</span>
            </div>
          </div>
          <div className="vp-section">
            <h3>主题</h3>
            <div className="vp-grid three">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`vp-chip${theme === t.id ? ' active' : ''}`}
                  onClick={() => setTheme(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <p className="vp-note">字号会重新排版当前章节；主题作用于手机屏。</p>
        </div>
      )}

      <TocDrawer
        open={tocOpen}
        chapters={chapters}
        current={chapterIdx}
        onSelect={jumpChapter}
        onClose={() => setTocOpen(false)}
      />
      <VoicePanel
        open={voiceOpen}
        voiceKey={voiceKey}
        rate={rate}
        onVoice={setVoiceKey}
        onRate={setRate}
        onClose={() => setVoiceOpen(false)}
        onStart={() => {
          setVoiceOpen(false)
          if (paged) playPageAt(paged, speechPage)
        }}
      />
    </div>
  )
}
