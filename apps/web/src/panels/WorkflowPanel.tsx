/**
 * 创作模式 · 工作流视图（参考 Agentic Workflow 节点画布重构）：
 * - 章节轨道：最近章节卡（交付✓ / 写作中金框呼吸 / 待写灰），点击进阅读器；
 * - 执行画布：React Flow 节点图（ExecutionCanvas）——Start 节点 + 工具调用节点沿事实链实时生长，
 *   连线按工具类别着色，运行中绿描边呼吸 / 出错绯红 / 完成定格（ComfyUI/节点画布点亮语义）；
 *   双层布局细节见 ExecutionCanvas.tsx。
 * 状态派生原则：只画「本轮实际发生的工具调用」（runLive.calls），零猜测——不预渲染未来步骤。
 */
import type { RunLive } from '../chat/RunLive.ts'
import { Icon } from '../components/Icon.tsx'
import { ExecutionCanvas } from './ExecutionCanvas.tsx'

/** 工作流步骤定义：工具名 → 步骤（ChatPanel 的 seen 派生仍在用；画布本身直接画工具调用序列） */
export const WF_STEPS: Array<{ id: string; label: string; desc: string; icon: string; tools: string[] }> = [
  {
    id: 'prep',
    label: '读上下文',
    desc: '细纲 · 追踪 · 设定 · 文风',
    icon: 'folder-open',
    tools: ['Read', 'Glob', 'Grep', 'ListFiles', 'load_skill', 'query_tracking', 'web_search', 'web_fetch'],
  },
  { id: 'draft', label: '网页AI初稿', desc: '通道 B · ask_ai 操控浏览器生成', icon: 'monitor', tools: ['ask_ai'] },
  { id: 'write', label: '精修与落盘', desc: '评估初稿 · 定点改写 · Write 正文', icon: 'file-pen', tools: ['Write', 'Edit'] },
  { id: 'gate', label: '门禁质检', desc: '4 脚本：AI味 / 抄纲 / 退化 / 标点', icon: 'stop-shield', tools: ['Bash'] },
  { id: 'track', label: '追踪提交', desc: 'tracking commit · 修订号推进', icon: 'dna', tools: ['tracking'] },
]

/** 工具名 → 步骤 id（不在表内的工具归 null） */
export function wfStepOfTool(name: string): string | null {
  const hit = WF_STEPS.find((s) => s.tools.includes(name))
  return hit ? hit.id : null
}

export function WorkflowPanel({
  latestChapter,
  runLive,
  modelLabel = null,
}: {
  /** 下一章提示用 */
  latestChapter: number
  runLive: RunLive | null
  /** 当前模型徽章（画布 Start 节点展示） */
  modelLabel?: string | null
}): React.JSX.Element {
  const hasRound = (runLive?.timeline.length ?? 0) > 0
  const callCount = runLive?.timeline.reduce((n, t) => n + (t.kind === 'step' ? t.calls.length : 0), 0) ?? 0
  const errCount =
    runLive?.timeline.reduce((n, t) => n + (t.kind === 'step' ? t.calls.filter((c) => c.state === 'error').length : 0), 0) ?? 0

  return (
    <div className="wf-panel">
      {/* ── 执行画布（管线卡外壳：LIVE 头部 + React Flow 画布 + 终端日志行 + 统计脚注，参考 EnterpriseAIPipeline） ── */}
      <div className="wf-canvas">
        {runLive && hasRound ? (
          <div className="ecn-card">
            <div className="ecn-card-head">
              <span className="ecn-live-dot" />
              <span className="ecn-card-title">AGENT PIPELINE · {runLive.working ? 'LIVE' : 'IDLE'}</span>
              <span className="ecn-card-meta">
                {runLive.timeline.filter((t) => t.kind === 'step').length} 步 · {callCount} 次工具
                {errCount > 0 ? ` · ${errCount} 错误` : ' · 0 错误'}
              </span>
            </div>
            <div className="ecn-card-body">
              <ExecutionCanvas runLive={runLive} modelLabel={modelLabel} />
            </div>
            <div className="ecn-card-log" key={runLive.action ?? 'idle'}>
              <span className="ecn-log-caret">›</span>
              <span className="ecn-log-text">
                {runLive.action
                  ? `${runLive.action}${runLive.working ? '' : '（本轮已完成）'}`
                  : runLive.working
                    ? '深度思考中…'
                    : '空闲中——等待下一个任务'}
              </span>
            </div>
            <div className="ecn-card-foot">
              <span className="ecn-kv">
                <i>TOOLS</i>
                <b>{callCount}</b>
              </span>
              <span className="ecn-kv">
                <i>STEPS</i>
                <b>{runLive.timeline.filter((t) => t.kind === 'step').length}</b>
              </span>
              {runLive.chapter !== null && (
                <span className="ecn-kv">
                  <i>WRITING</i>
                  <b>第 {runLive.chapter} 章</b>
                </span>
              )}
              <span className="ecn-stack">
                <i>MODEL</i>
                <b>{runLive.model ?? modelLabel ?? '—'}</b>
              </span>
            </div>
          </div>
        ) : (
          <div className="wf-idle-hint">
            <Icon name="spark" size={13} /> 空闲中——对 Agent 说「写第 {latestChapter + 1} 章」，执行画布会随调用逐步生长
          </div>
        )}
      </div>
    </div>
  )
}
