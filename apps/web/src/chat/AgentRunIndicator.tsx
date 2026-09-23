/**
 * Agent 执行指示器（brutalist 混凝土板，视觉参考 未添加的样式/任务列表重构.txt 适配主题系统）：
 *  - 执行中常驻输入栏上方：3px 主色厚框直角块 + 斜纹肌理 + 四角工业括号 + 边缘铆钉 + 循环扫描线
 *    + 状态文字 + 实时耗时；悬停浮现 SYS// 系统标签并叠三层错位板影；
 *  - 任务完成转完成态（TASK//COMPLETED · 玉青色 · 定格耗时），仍可 hover 查看本轮消耗；
 *  - 鼠标悬停向上翻出独立混凝土板：本轮真实 token 消耗——模型调用次数 / 输入输出 / 缓存命中率 /
 *    上下文占用条 + 五段构成（系统/技能/工具/消息/其他）——数据来自 WS agent:usage 逐步快照，
 *    首步模型调用未返回前显示占位文案（上浮面板不挤动输入栏布局）。
 *  纯展示组件：不采集数据（调用方传 working/elapsed/done/usage），任何模式一 working 即显示。
 */
import type { ReactNode } from 'react'

/** 本轮 token 消耗快照（WS agent:usage 载荷去掉 type/sessionId 的部分，与服务端 AgentUsageSnapshot 同构） */
export interface RunUsageSnapshot {
  calls: number
  inputTokens: number
  outputTokens: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 最近一次模型调用的输入 ≈ 当前上下文占用 */
  lastInputTokens: number
  breakdown: { system: number; skills: number; tools: number; messages: number; other: number }
  capacity: { model: string; tokens: number }
}

/** 本轮任务结局：成功 / 出错（模型调用失败·空回复）/ 手动终止（用户停止） */
export type RunOutcome = 'success' | 'error' | 'stopped'

/** token 数 → K/M 简写（面板紧凑展示） */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 秒数 → 人类可读时长（与 ChatPanel.fmtDuration 同格式；独立副本避免与 ChatPanel 循环依赖） */
function fmtDur(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分${String(r).padStart(2, '0')}秒`
  if (m > 0) return `${m}分${String(r).padStart(2, '0')}秒`
  return `${r}秒`
}

export function AgentRunIndicator({
  working,
  statusLabel,
  elapsed,
  done,
  usage,
  crossRun,
  currentAction,
  steps,
}: {
  /** Agent 是否执行中（submitted/streaming） */
  working: boolean
  /** 状态短句（等待响应/深度思考中/工具执行中/执行完成/执行出错/已手动终止），调用方组装 */
  statusLabel: string
  /** 实时已耗时秒（执行中跳动；完成态用 done.seconds 定格） */
  elapsed: number
  /** 完成定格（任务真正结束才有；审批/表单停靠不算），含总耗时秒与结局（成功/出错/终止） */
  done: { seconds: number; outcome: RunOutcome } | null
  /** 本次任务的 token 消耗（跨审批/表单续跑轮累计；上下文占用取最近一轮） */
  usage: RunUsageSnapshot | null
  /** true = 显示值含此前轮次的累计（跨 run 续跑），面板展示「任务累计」标记 */
  crossRun?: boolean
  /** 当前动作一行摘要（最后一张工具卡：工具名 · 参数摘要），仅执行中显示 */
  currentAction?: string | null
  /** 步骤进度（WS agent:step 驱动）：斜纹进度条 + n/total */
  steps?: { step: number; total: number } | null
}): ReactNode {
  if (!working && !done) return null
  const u = usage && usage.calls > 0 ? usage : null
  const cacheRate = u && u.inputTokens > 0 ? Math.round((u.cacheReadTokens / u.inputTokens) * 100) : null
  const bd = u?.breakdown
  const bdTotal = bd ? bd.system + bd.skills + bd.tools + bd.messages + bd.other : 0
  const ctxPct = u && u.capacity.tokens > 0 ? Math.min(100, (u.lastInputTokens / u.capacity.tokens) * 100) : 0
  const seg = (n: number): number => Math.round((n / bdTotal) * 100)

  /** 终态三变体：成功=玉青 COMPLETED / 出错=绯红 FAILED / 手动终止=琥珀 STOPPED（主色走 --ari-accent） */
  const oc = done?.outcome ?? 'success'
  const doneCls = working ? 'ari-run' : `ari-done${oc === 'error' ? ' ari-err' : oc === 'stopped' ? ' ari-stop' : ''}`
  const sysLabel = working ? 'SYS//AGENT_RUN' : oc === 'error' ? 'ERR//TASK_FAILED' : oc === 'stopped' ? 'SYS//TASK_STOPPED' : 'LOG//TASK_CLOSED'
  const tagLabel = working ? 'AGENT//RUNNING' : oc === 'error' ? 'TASK//FAILED' : oc === 'stopped' ? 'TASK//STOPPED' : 'TASK//COMPLETED'

  return (
    <div className={`ari ${doneCls}`}>
      <div className="ari-texture" />
      <i className="ari-corner ari-tl" />
      <i className="ari-corner ari-tr" />
      <i className="ari-corner ari-bl" />
      <i className="ari-corner ari-br" />
      <i className="ari-rivet l" />
      <i className="ari-rivet r" />
      <div className="ari-scan" />
      <span className="ari-sys">{sysLabel}</span>
      <div className="ari-head">
        <span className="ari-tag">{tagLabel}</span>
        <i className="ari-dot" />
        <span className="ari-status">{statusLabel}</span>
        <span className="ari-time">{fmtDur(working ? elapsed : done?.seconds ?? 0)}</span>
      </div>
      {/* 驾驶舱（仅执行中）：当前动作一行 + 步骤进度条——数据来自流内工具 part 与 WS agent:step */}
      {working && (currentAction || (steps && steps.step > 0)) && (
        <div className="ari-cockpit">
          {currentAction && (
            <div className="ari-action" title={currentAction}>
              <span className="ari-action-tag">NOW</span>
              <span className="ari-action-text">{currentAction}</span>
            </div>
          )}
          {steps && steps.step > 0 && steps.total > 0 && (
            <div className="ari-progress">
              <div className="ari-progress-bar">
                <i style={{ width: `${Math.min(100, (steps.step / steps.total) * 100)}%` }} />
              </div>
              <span className="ari-progress-n">
                {steps.step}/{steps.total}
              </span>
            </div>
          )}
        </div>
      )}
      <div className="ari-panel">
        <div className="ari-panel-in">
          {u ? (
            <>
              {crossRun && (
                <div className="ari-cross">
                  本次任务累计（含此前问答/审批轮次，上下文占用取最近一轮）
                </div>
              )}
              <div className="ari-stats">
                <div className="ari-stat">
                  <b>{u.calls}</b>
                  <span>模型调用</span>
                </div>
                <div className="ari-stat">
                  <b>{fmtTokens(u.inputTokens)}</b>
                  <span>输入 token</span>
                </div>
                <div className="ari-stat">
                  <b>{fmtTokens(u.outputTokens)}</b>
                  <span>输出 token</span>
                </div>
                <div className="ari-stat">
                  <b>{cacheRate !== null ? `${cacheRate}%` : '—'}</b>
                  <span>缓存命中</span>
                </div>
              </div>
              <div className="ari-ctx">
                <div className="ari-ctx-head">
                  <span>上下文占用 {ctxPct.toFixed(1)}%</span>
                  <span className="ari-ctx-cap">
                    {fmtTokens(u.lastInputTokens)} / {fmtTokens(u.capacity.tokens)} · {u.capacity.model}
                  </span>
                </div>
                <div className="ari-ctx-bar">
                  {ctxPct > 0.5 && <i className="ari-seg" style={{ width: `${ctxPct}%` }} />}
                </div>
                {bd != null && bdTotal > 0 && (
                  <>
                    <div className="ari-ctx-mix">
                      <i style={{ width: `${seg(bd.system)}%` }} title={`系统 ${fmtTokens(bd.system)}`} />
                      <i style={{ width: `${seg(bd.skills)}%` }} title={`技能目录 ${fmtTokens(bd.skills)}`} />
                      <i style={{ width: `${seg(bd.tools)}%` }} title={`工具定义 ${fmtTokens(bd.tools)}`} />
                      <i style={{ width: `${seg(bd.messages)}%` }} title={`历史消息 ${fmtTokens(bd.messages)}`} />
                      <i style={{ width: `${seg(bd.other)}%` }} title={`其他（角色标记等） ${fmtTokens(bd.other)}`} />
                    </div>
                    <div className="ari-legend">
                      <span>
                        <i className="s1" />系统 {seg(bd.system)}%
                      </span>
                      <span>
                        <i className="s2" />技能 {seg(bd.skills)}%
                      </span>
                      <span>
                        <i className="s3" />工具 {seg(bd.tools)}%
                      </span>
                      <span>
                        <i className="s4" />消息 {seg(bd.messages)}%
                      </span>
                      <span>
                        <i className="s5" />其他 {seg(bd.other)}%
                      </span>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="ari-empty">首步模型调用尚未返回，token 消耗统计将在第一次 step 结束后出现…</div>
          )}
        </div>
      </div>
    </div>
  )
}
