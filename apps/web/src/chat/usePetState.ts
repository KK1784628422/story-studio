/**
 * 桌宠状态聚合 hook（桌宠常驻升级实现方案 §4.3/§4.4）：
 * 收集创作全程的全部业务信号 → 按固定优先级仲裁出单一 PetState；高优先级出现即抢占（交叉淡入过去），
 * 消失后自动回落到余下最高优先级。信号全部现成（路由状态机 / useChat status / 审批·提问·登录交接 /
 * WS agent:status · browser:agent-control · agent:step / 工具 part 活跃启发式 / 步数上限 / 错误），零后端硬依赖。
 *
 * 时效窗口（0.5s 心跳驱动过期回落）：
 *  - agent:status 'stopped' → 2s 短窗（停止亮相后回 idle）
 *  - agent:step → 8s 近窗（工具活动启发式：步进事件后 8s 内视为 executing）
 *  - error → 6s 后回落 idle（避免一次报错让桌宠永远垂头）
 *  - done → 1.1s 停留锁（亮相期内不被低优先级抢占，到期回调 onDoneFinished 卸载路由状态机）
 */
import { useEffect, useRef, useState } from 'react'
import type { WsEvent } from '@story-studio/shared'

/** 路由桌宠阶段机（沿用原 RoutePendingBot：preparing → working → done → 卸载） */
export type RoutePhase = 'preparing' | 'working' | 'done'

/** 桌宠 12 态（browsing 为 executing 的浏览器操控子形态，与绿光圈联动） */
export type PetState =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'thinking'
  | 'executing'
  | 'browsing'
  | 'approving'
  | 'login'
  | 'asking'
  | 'done'
  | 'error'
  | 'capped'
  | 'stopped'

/** 桌宠全部状态（调试器枚举用，按优先级从高到低） */
export const PET_STATES: PetState[] = [
  'error',
  'approving',
  'login',
  'asking',
  'browsing',
  'executing',
  'thinking',
  'waiting',
  'preparing',
  'capped',
  'done',
  'stopped',
  'idle',
]

/** 仲裁优先级：大者胜（browsing 与 executing 同层，browsing 展示优先） */
const PRIORITY: Record<PetState, number> = {
  error: 90,
  approving: 80,
  login: 70,
  asking: 60,
  executing: 50,
  browsing: 50,
  thinking: 40,
  waiting: 30,
  preparing: 25,
  capped: 20,
  done: 15,
  stopped: 12,
  idle: 0,
}

/** WS / 错误信号的时效窗口（ms） */
const STOPPED_TTL = 2_000
const STEP_TTL = 8_000
const ERROR_TTL = 6_000
/** done 亮相停留时长（沿用原 RoutePendingBot 1.1s） */
export const DONE_HOLD_MS = 1_100

export interface PetSignals {
  /** 路由状态机（ChatPanel 现有 routePhase，含 preparing→working→done） */
  routePhase: 'idle' | RoutePhase
  /** useChat status：submitted / streaming / ready / error */
  chatStatus: string
  /** 发送/流式出错（useChat error 或空回复提示） */
  hasError: boolean
  /** 未决写入审批数 */
  pendingApprovals: number
  /** 浏览器登录人工交接进行中（browser:login-required 置位） */
  loginReq: boolean
  /** Agent 向你提问（最后一条消息在等回复 / 内嵌问答或确认表单） */
  asking: boolean
  /** 已撞单轮步数上限 */
  stepCapped: boolean
  /** 工具执行启发式：最后一条 assistant 消息存在未完成 tool part（仅工作期间采信） */
  toolActive: boolean
  /** useChat 工作中（submitted / streaming） */
  working: boolean
  /** done 亮相结束 → 卸载路由状态机（原 RoutePendingBot.onFinished 职责迁入） */
  onDoneFinished: () => void
}

export function usePetState(wsEvent: WsEvent | null | undefined, s: PetSignals): PetState {
  /** WS agent:status 最新相位（带时间戳，stopped 走 2s 短窗） */
  const [agentPhase, setAgentPhase] = useState<{ phase: 'idle' | 'thinking' | 'tool' | 'stopped'; at: number } | null>(null)
  /** 浏览器 Agent 接管中（browser:agent-control active，与 WorkPanel 绿光圈同源） */
  const [browsing, setBrowsing] = useState(false)
  /** 最近一次 agent:step 时刻（工具活动近窗数据源） */
  const [lastStepAt, setLastStepAt] = useState(0)
  /** 心跳：驱动各时效窗口过期回落（无信号变化时也能「到点归位」） */
  const [, tick] = useState(0)

  useEffect(() => {
    if (!wsEvent) return
    if (wsEvent.type === 'agent:status') setAgentPhase({ phase: wsEvent.phase, at: Date.now() })
    else if (wsEvent.type === 'browser:agent-control') setBrowsing(wsEvent.active)
    else if (wsEvent.type === 'agent:step') setLastStepAt(Date.now())
  }, [wsEvent])

  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 500)
    return () => clearInterval(t)
  }, [])

  /** 错误起始时刻：hasError 由 false→true 时记录（6s 窗口起点） */
  const errorAtRef = useRef(0)
  const prevErrorRef = useRef(false)
  if (s.hasError && !prevErrorRef.current) errorAtRef.current = Date.now()
  prevErrorRef.current = s.hasError

  const now = Date.now()
  const inStepWindow = now - lastStepAt < STEP_TTL
  const stoppedFresh = agentPhase !== null && agentPhase.phase === 'stopped' && now - agentPhase.at < STOPPED_TTL
  const errorFresh = s.hasError && (errorAtRef.current === 0 || now - errorAtRef.current < ERROR_TTL)

  // ── 仲裁（自上而下，首个命中即胜出）──
  let raw: PetState = 'idle'
  if (errorFresh) raw = 'error'
  else if (s.pendingApprovals > 0) raw = 'approving'
  else if (s.loginReq) raw = 'login'
  else if (s.asking) raw = 'asking'
  else if (s.working && browsing) raw = 'browsing'
  else if (s.working && (s.toolActive || inStepWindow)) raw = 'executing'
  else if (s.working && s.chatStatus === 'streaming') raw = 'thinking'
  else if (s.working && s.chatStatus === 'submitted') raw = 'waiting'
  else if (s.routePhase === 'preparing') raw = 'preparing'
  else if (s.stepCapped) raw = 'capped'
  else if (s.routePhase === 'done') raw = 'done'
  else if (stoppedFresh) raw = 'stopped'

  // ── done 停留锁：亮相期内低优先级信号不抢占（高优先级 error/approving/login/asking 仍可立即接管）──
  const doneAtRef = useRef(0)
  if (raw === 'done' && doneAtRef.current === 0) doneAtRef.current = now
  if (raw !== 'done') doneAtRef.current = 0
  const holdDone = raw !== 'done' && doneAtRef.current !== 0 && now - doneAtRef.current < DONE_HOLD_MS && PRIORITY[raw] < PRIORITY.done

  // done 亮相结束回调：进入 done 启动一次性 1.1s 计时（回调走 ref，父组件重渲染不重置倒计时）
  const onDoneFinishedRef = useRef(s.onDoneFinished)
  onDoneFinishedRef.current = s.onDoneFinished
  useEffect(() => {
    if (raw !== 'done') return
    const t = setTimeout(() => onDoneFinishedRef.current(), DONE_HOLD_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw === 'done'])

  return holdDone ? 'done' : raw
}
