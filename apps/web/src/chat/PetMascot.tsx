/**
 * 常驻桌宠（桌宠常驻升级实现方案 §4.1/§4.5，纯展示层）：
 * 锚定输入栏（.chat-input-row 相对定位 + absolute，拖宽/面板开合/窗口缩放自动跟随，零测量代码）。
 * 位置/大小/话痨密度/显示隐藏等个性化在「设置中心 · 外观 · 桌宠」调节（chat/PetSettings.tsx + chat/petPrefs.ts）。
 *
 * 表现（pet.html 已验证方案移植）：
 *  - 叠图交叉淡入：全部状态 <img> 常驻堆叠（opacity:0），激活态切 .active（0→1 + scale 0.92→1，0.45s），切换零闪烁、天然预加载；
 *  - 光晕：按状态配色的 --pet-accent 径向光晕（idle/capped/stopped 无）；
 *  - 话痨气泡：每态一组台词随机轮播；状态变更必说，话痨密度下换到「不一样的台词」也会重新弹出气泡（静默密度只在 hover 时展示）；
 *  - 粒子：preparing 火花上溅 / done 星星爱心缤纷；
 *  - 计时牌：执行类状态（preparing/waiting/thinking/executing/browsing）桌宠正下方挂 Agent 已耗时；
 *  - 眨眼：idle 态每 3~5s 闪 120ms 闭眼帧；
 *  - prefers-reduced-motion：27-a11y.css 全局将动画压到 0.01ms，自动退化为静态姿势+文案。
 */
import { useEffect, useRef, useState } from 'react'
import type { PetState, RoutePhase } from './usePetState.ts'
import { usePetPrefs } from './petPrefs.ts'

import imgIdle from '../assets/pet/pet-idle.webp'
import imgIdleBlink from '../assets/pet/pet-idle-blink.webp'
import imgTyping from '../assets/pet/pet-typing.webp'
import imgWait from '../assets/pet/pet-wait.webp'
import imgThink from '../assets/pet/pet-think.webp'
import imgWork from '../assets/pet/pet-work.webp'
import imgApprove from '../assets/pet/pet-approve.webp'
import imgAsk from '../assets/pet/pet-ask.webp'
import imgHappy from '../assets/pet/pet-happy.webp'
import imgSad from '../assets/pet/pet-sad.webp'
import imgStopped from '../assets/pet/pet-stopped.webp'

/** 状态 → 姿势图（login 无专属图，按方案用「递写字板/等待确认」顶替，语义一致） */
const PET_IMG: Record<PetState, string> = {
  idle: imgIdle,
  preparing: imgTyping,
  waiting: imgWait,
  thinking: imgThink,
  executing: imgWork,
  browsing: imgWork,
  approving: imgApprove,
  login: imgApprove,
  asking: imgAsk,
  done: imgHappy,
  error: imgSad,
  capped: imgSad,
  stopped: imgStopped,
}

/** 叠图层（去重；idle/眨眼帧单独处理激活） */
const STACK_IMGS: Array<{ key: string; src: string }> = [
  { key: 'idle', src: imgIdle },
  { key: 'idle-blink', src: imgIdleBlink },
  { key: 'typing', src: imgTyping },
  { key: 'wait', src: imgWait },
  { key: 'think', src: imgThink },
  { key: 'work', src: imgWork },
  { key: 'approve', src: imgApprove },
  { key: 'ask', src: imgAsk },
  { key: 'happy', src: imgHappy },
  { key: 'sad', src: imgSad },
  { key: 'stopped', src: imgStopped },
]

/** 光晕主题色（方案 §4.5：browsing 青绿呼应绿光圈；idle/capped/stopped 无光晕） */
export const ACCENT: Partial<Record<PetState, string>> = {
  preparing: '#4cc3ff',
  waiting: '#5b8dff',
  thinking: '#a78bfa',
  executing: '#f0a75a',
  browsing: '#34d399',
  approving: 'var(--gold, #d4af6a)',
  login: '#ffb454',
  asking: '#7cc9a0',
  done: '#5aa87c',
  error: '#e0483e',
}

/** 每态动效（data-anim 驱动 CSS keyframes） */
const ANIM: Record<PetState, string> = {
  idle: 'float',
  preparing: 'type',
  waiting: 'look',
  thinking: 'think',
  executing: 'work',
  browsing: 'work',
  approving: 'step',
  login: 'wave',
  asking: 'tilt',
  done: 'cheer',
  error: 'droop',
  capped: 'droop',
  stopped: 'rest',
}

/** 气泡标题（短语定调）+ 台词库（副文案随机轮播，话痨模式）；TITLE 同时供顶栏胶囊的 Agent 状态段复用 */
export const TITLE: Record<PetState, string> = {
  idle: '待命中',
  preparing: '正在识别意图',
  waiting: '已发送',
  thinking: '深度思考中',
  executing: '执行工具中',
  browsing: '正在操控浏览器',
  approving: '等你批准',
  login: '需要你登录网站',
  asking: 'Agent 向你提问',
  done: '已就绪 ✓',
  error: '出了点问题',
  capped: '到达步数上限',
  stopped: '已停止',
}

const LINES: Record<PetState, string[]> = {
  idle: [
    '待命中，随时开工！',
    '在想什么故事？说出来听听～',
    '今天也要日更五千吗？',
    '摸鱼中…不对，是待机！',
    '灵感卡壳？来聊聊主角吧',
    '戳一戳我，马上进入状态',
    '右下角的黑胶唱片可以听歌哦',
    '「设置中心 · 外观」里可以调我的位置和大小哦',
  ],
  preparing: [
    '正在识别你的意图…',
    '翻工具箱，别催！',
    '路由中，毫秒级的事',
    '系好工具腰带！',
    '蓄力中，马上就好…',
  ],
  waiting: [
    '已发送，等 Agent 醒神…',
    '信号已发出，滴——',
    '排队中，前面没人别急',
    '正在唤醒深度思考…',
    '首字马上就到！',
  ],
  thinking: [
    '剧情走向推演中…',
    '这里用哪个梗更好呢？',
    '思路正在收敛…',
    '嘘，大脑过载运转中',
    '人物动机再盘一遍…',
  ],
  executing: [
    '埋头苦干中，别戳我',
    '工具抡起来了！',
    '键盘敲出火星子了',
    '这步做完就顺了',
    '步骤 +1，稳住',
  ],
  browsing: [
    '正在操控浏览器…',
    '网页翻页中…',
    '在替你盯着页面呢',
    '扫榜数据进行时…',
    '页面结构看明白了',
  ],
  approving: [
    '有写入请求，等你签字！',
    '批不批？在线等',
    '文件已备好，请过目',
    '举手请求授权！',
    '批了我马上开工',
  ],
  login: [
    '需要你登录网站～',
    '门口等你扫码中…',
    '登录完喊我一声',
    '密码我不看，Promise！',
    '人工交接时刻…',
  ],
  asking: [
    '该你拍板了！',
    '问题已发出，等你答案',
    '选 A 还是 B？',
    '别走，就差你一句',
    '帮你列好选项啦',
  ],
  done: [
    '搞定！这一轮跑完了 ✓',
    '交付！夸我夸我',
    '任务完成，击个掌',
    '美美收工～',
    '看，我说能行吧',
  ],
  error: [
    '呜，出了点问题…',
    '翻车了，看看报错？',
    '不是我的错！（小声）',
    '重试一下说不定就好',
    '错误已记录，别慌',
  ],
  capped: [
    '步数用完啦，回个「继续」',
    '到站了，请续杯',
    '上限已到，进度都留着',
    '歇口气，回「继续」接着跑',
    '电量 1%，说「继续」充电',
  ],
  stopped: [
    '被叫停了，休息一下',
    '好嘞，先停这儿',
    '随时可以再出发',
    '打哈欠…叫我吗？',
    '待机中，勿念',
  ],
}

/** 执行类状态：桌宠正下方挂 Agent 已耗时计时牌 */
const RUNNING: ReadonlySet<PetState> = new Set(['preparing', 'waiting', 'thinking', 'executing', 'browsing'])

/** 台词轮播间隔（ms）：话痨密度下每换一句重新弹出气泡 */
const LINE_ROTATE_MS = 7_000
/** 气泡自动展示时长（ms） */
const BUBBLE_FLASH_MS = 3_000

export function PetMascot({
  state,
  phase,
  agentElapsed,
  onFocusInput,
  onScrollBottom,
}: {
  state: PetState
  /** 路由阶段（null=未在路由期）：preparing 期用内部毫秒计时，其余执行态用 Agent 耗时 */
  phase: RoutePhase | null
  /** Agent 已耗时（秒，runStart 起算） */
  agentElapsed: number
  /** idle 点击 → 聚焦输入框 */
  onFocusInput: () => void
  /** working 点击 → 回到底部 */
  onScrollBottom: () => void
}): React.JSX.Element {
  // 个性化偏好（与设置中心「外观 · 桌宠」共享同一状态源；hidden 由 ChatPanel 决定不渲染）
  const prefs = usePetPrefs()

  // ── preparing 内部计时（发送→submitted 之间的路由窗口没有 agentElapsed，用本地毫秒表补位）──
  const startRef = useRef(performance.now())
  const [prepMs, setPrepMs] = useState(0)
  useEffect(() => {
    if (phase !== 'preparing') return
    startRef.current = performance.now()
    setPrepMs(0)
    const t = setInterval(() => setPrepMs(performance.now() - startRef.current), 100)
    return () => clearInterval(t)
  }, [phase])
  const timerSec = phase === 'preparing' ? prepMs / 1000 : agentElapsed

  // ── idle 眨眼：每 3~5s 闪 120ms 闭眼帧 ──
  const [blink, setBlink] = useState(false)
  useEffect(() => {
    if (state !== 'idle') {
      setBlink(false)
      return
    }
    let alive = true
    let t1 = 0
    let t2 = 0
    const schedule = () => {
      if (!alive) return
      t1 = window.setTimeout(() => {
        if (!alive) return
        setBlink(true)
        t2 = window.setTimeout(() => {
          if (!alive) return
          setBlink(false)
          schedule()
        }, 120)
      }, 3000 + Math.random() * 2000)
    }
    schedule()
    return () => {
      alive = false
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [state])

  // ── 话痨台词：进入状态随机来一句；停留期间每 7s 换一句 ──
  const [lineIdx, setLineIdx] = useState(0)
  useEffect(() => {
    const list = LINES[state]
    setLineIdx(Math.floor(Math.random() * list.length))
    const t = setInterval(() => setLineIdx((i) => (i + 1) % list.length), LINE_ROTATE_MS)
    return () => clearInterval(t)
  }, [state])
  const line = LINES[state][lineIdx % LINES[state].length]

  // ── 气泡开麦：状态变更必说（静默密度除外）；话痨密度下换到「不一样的台词」也重新弹出 ──
  const [hover, setHover] = useState(false)
  const [flash, setFlash] = useState(true)
  useEffect(() => {
    if (prefs.chat === 'quiet') {
      setFlash(false)
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), BUBBLE_FLASH_MS)
    return () => clearTimeout(t)
  }, [state, prefs.chat])
  const spokenRef = useRef('')
  useEffect(() => {
    if (prefs.chat !== 'chatty') return
    if (spokenRef.current === line) return
    spokenRef.current = line
    setFlash(true)
    const t = setTimeout(() => setFlash(false), BUBBLE_FLASH_MS)
    return () => clearTimeout(t)
  }, [line, prefs.chat])
  const bubbleOpen = hover || flash

  const accent = ACCENT[state]
  const activeSrc = PET_IMG[state]

  const handleClick = () => {
    if (state === 'idle') onFocusInput()
    else if (state === 'waiting' || state === 'thinking' || state === 'executing' || state === 'browsing') onScrollBottom()
  }

  return (
    <div
      className={`pet-mascot pet-${state} pet-pos-${prefs.pos} pet-size-${prefs.size}`}
      data-anim={ANIM[state]}
      style={accent ? ({ '--pet-accent': accent } as React.CSSProperties) : undefined}
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={state === 'idle' ? '点击聚焦输入框' : undefined}
    >
      {/* 状态光晕（--pet-accent 按态配色；无光晕态不渲染） */}
      {accent && <div className="pet-glow" />}

      {/* 叠图交叉淡入：全部姿势常驻堆叠，激活态 .active（idle 态在原型/闭眼帧间切眨眼） */}
      <div className="pet-stack">
        {STACK_IMGS.map((im) => {
          const isActive =
            state === 'idle'
              ? im.key === (blink ? 'idle-blink' : 'idle')
              : im.src === activeSrc && im.key !== 'idle' && im.key !== 'idle-blink'
          return <img key={im.key} src={im.src} alt="" className={`pet-img${isActive ? ' active' : ''}`} draggable={false} />
        })}
        {state === 'preparing' && (
          <div className="pet-sparks">
            <span>✦</span>
            <span>＋</span>
            <span>✧</span>
          </div>
        )}
        {state === 'done' && (
          <div className="pet-confetti">
            <span>✦</span>
            <span>✧</span>
            <span>♥</span>
            <span>＋</span>
          </div>
        )}
      </div>

      {/* 计时牌：执行类状态挂在桌宠正下方 */}
      {RUNNING.has(state) && (
        <div className="pet-timer">
          <i />
          {timerSec.toFixed(1)}s
        </div>
      )}

      {/* 话痨气泡：状态标题 + 随机台词（换到新台词会重新弹出） */}
      <div className={`pet-bubble${bubbleOpen ? ' show' : ''}`} aria-live="polite">
        <span className="pet-bubble-label">
          {RUNNING.has(state) && <i className="dot" />}
          {TITLE[state]}
        </span>
        <span className="pet-bubble-text">{line}</span>
      </div>
    </div>
  )
}
