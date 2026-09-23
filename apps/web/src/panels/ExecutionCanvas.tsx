/**
 * 执行画布（参考 Agentic Workflow 节点画布 + EnterpriseAIPipeline · React Flow 实现）：
 * - 水平时间线：沿 X 轴向右无限生长（Start → 思考 → 工具 → 思考 → …），不纵向堆叠
 * - 每条用户消息 = Start 节点；每条 assistant 消息 = 一步：思考大框 → 工具调用
 *   （连续同名工具纵向并列扇出 / 不同类型工具推进下一列）
 * - 连线：全线虚线流动动画 + 箭头；彗星点沿路径跑（活动边三颗亮、普通边两颗暗，SVG animateMotion）
 * - 运行中节点强高亮：绿底 + 顶部光带 + 大辉光呼吸 + 「执行中」状态文字
 * - 相机：执行中平移跟随最新节点（不缩放），本轮完成时 fitView 全景收拢
 * - 只增不减：节点源自 runLive.timeline 累积器，上游流替换不丢已画节点
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  getBezierPath,
  useReactFlow,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeProps,
  type Edge,
  type EdgeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { RunLive, RunLiveCall, RunLiveItem } from '../chat/RunLive.ts'
import { Icon } from '../components/Icon.tsx'
import { metaOf } from '../chat/toolMeta.ts'

/** 工具连线色：直接取工具专属色（与聊天任务栏同一事实源 toolMeta） */
function colorOf(name: string): string {
  return metaOf(name).color
}
/** 工具图标名（toolMeta 单一事实源） */
function iconOf(name: string): string {
  return metaOf(name).icon
}

interface StartNodeData extends Record<string, unknown> {
  task: string
  model: string | null
  working: boolean
}
interface ThinkNodeData extends Record<string, unknown> {
  text: string
}
interface ToolNodeData extends Record<string, unknown> {
  name: string
  summary: string
  state: 'running' | 'done' | 'error'
  color: string
  icon: string
}

/** Start 节点：绿色播放瓷片 + 本轮指令 + 运行时真实模型徽章 */
function StartNode({ data }: NodeProps<Node<StartNodeData>>) {
  return (
    <div className={`ecn-node ecn-start${data.working ? ' running' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <span className="ecn-tile start">
        <Icon name="spark" size={18} />
      </span>
      <span className="ecn-body">
        <b className="ecn-title">{data.task || '任务开始'}</b>
        {data.model && <span className="ecn-chip">{data.model}</span>}
      </span>
    </div>
  )
}

/** 思考大框：紫调虚线框 + 「思考」标签 + 思考正文 */
function ThinkNode({ data }: NodeProps<Node<ThinkNodeData>>) {
  return (
    <div className="ecn-node ecn-think">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <span className="ecn-think-tag">
        <Icon name="brain" size={11} /> 思考
      </span>
      <p className="ecn-think-text" title={data.text}>
        {data.text}
      </p>
    </div>
  )
}

/** 工具节点：彩色瓷片（工具专属色）+ 工具名 + 摘要 + 状态；运行中顶部光带 + 状态文字 */
function ToolNode({ data }: NodeProps<Node<ToolNodeData>>) {
  return (
    <div className={`ecn-node ecn-tool ${data.state}`}>
      {data.state === 'running' && <span className="ecn-beam" />}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <span className="ecn-tile" style={{ color: data.color }}>
        <Icon name={data.icon} size={18} />
      </span>
      <span className="ecn-body">
        <b className="ecn-title">{data.name}</b>
        <i className="ecn-summary" title={data.summary}>
          {data.summary}
        </i>
        {data.state === 'running' && (
          <span className="ecn-running-label">
            <span className="ecn-trio">
              <i style={{ animationDelay: '0s' }} />
              <i style={{ animationDelay: '0.4s' }} />
              <i style={{ animationDelay: '0.8s' }} />
            </span>
            执行中…
          </span>
        )}
      </span>
      <span className="ecn-state">
        {data.state === 'error' ? '✕' : data.state === 'done' ? '✓' : ''}
      </span>
    </div>
  )
}

const NODE_TYPES: NodeTypes = { start: StartNode, think: ThinkNode, tool: ToolNode }

/**
 * 管线连线（参考 EnterpriseAIPipeline）：虚线流动动画 + 箭头 + 彗星点（SVG animateMotion 零依赖）。
 * 活动边（当前运行工具的入边）三颗亮彗星；普通边两颗暗彗星——所有连线都有动态注入感。
 */
function PipelineEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const color = (data?.color as string) ?? '#94a3b8'
  const active = Boolean(data?.active)
  return (
    <>
      <path
        id={id}
        className="ecn-edge-path"
        d={path}
        fill="none"
        stroke={color}
        strokeOpacity={active ? 1 : 0.65}
        strokeWidth={active ? 6 : 5}
        strokeDasharray="3 5"
      />
      {active ? (
        <>
          <circle r={5} fill={color}>
            <animateMotion dur="1.1s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={3.8} fill={color} opacity={0.65}>
            <animateMotion dur="1.1s" begin="0.35s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={2.8} fill={color} opacity={0.4}>
            <animateMotion dur="1.1s" begin="0.7s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      ) : (
        <>
          <circle r={3.2} fill={color} opacity={0.55}>
            <animateMotion dur="2.2s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={2.2} fill={color} opacity={0.3}>
            <animateMotion dur="2.2s" begin="1.1s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      )}
    </>
  )
}

const EDGE_TYPES = { pipeline: PipelineEdge }

/** 水平布局常量（世界坐标）：中轴 y=0，节点沿 X 轴向右无限生长 */
const START_W = 260
const THINK_W = 400
const TOOL_W = 260
const GAP = 56
const STACK_SPAN = 136 // 并列堆叠的纵向间距（≥ 节点高 84 + 呼吸辉光余量）

function buildGraph(runLive: RunLive, modelLabel: string | null): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  // 当前运行中的调用 id（其入边三亮彗星 + 节点强高亮）
  const runningStep = [...runLive.timeline]
    .reverse()
    .find((it): it is Extract<RunLiveItem, { kind: 'step' }> => it.kind === 'step' && it.calls.some((c) => c.state === 'running'))
  const runningId = runningStep?.calls.find((c) => c.state === 'running')?.id ?? null
  let x = 0
  let anchor = ''

  runLive.timeline.forEach((item) => {
    if (item.kind === 'start') {
      const id = item.key
      nodes.push({
        id,
        type: 'start',
        position: { x, y: -42 },
        data: { task: item.task, model: runLive.model ?? modelLabel, working: runLive.working } as StartNodeData,
      })
      if (anchor) {
        edges.push({
          id: `${anchor}=>${id}`,
          source: anchor,
          target: id,
          type: 'pipeline',
          data: { color: '#22c55e', active: runLive.working },
        })
      }
      anchor = id
      x += START_W + GAP
      return
    }
    // 思考大框
    if (item.reasoning) {
      const id = `t${item.key}`
      nodes.push({ id, type: 'think', position: { x, y: -62 }, data: { text: item.reasoning } as ThinkNodeData })
      edges.push({
        id: `${anchor}=>${id}`,
        source: anchor,
        target: id,
        type: 'pipeline',
        data: { color: '#a78bfa', active: item.calls.some((c) => c.state === 'running') },
      })
      anchor = id
      x += THINK_W + GAP
    }
    // 工具组：连续同名工具纵向并列成一列（扇出），异类工具推进到下一列（链条）
    const groups: RunLiveCall[][] = []
    let group: RunLiveCall[] = []
    for (const c of item.calls) {
      if (group.length === 0 || group[0]!.name === c.name) group.push(c)
      else {
        groups.push(group)
        group = [c]
      }
    }
    if (group.length > 0) groups.push(group)
    groups.forEach((g) => {
      g.forEach((c, k) => {
        // 纵向居中堆叠：k 相对组中心偏移
        const yC = (k - (g.length - 1) / 2) * STACK_SPAN
        nodes.push({
          id: c.id,
          type: 'tool',
        position: { x, y: yC - 42 },
          data: {
            name: c.name,
            summary: c.summary,
            state: c.state,
            color: colorOf(c.name),
            icon: iconOf(c.name),
          } as ToolNodeData,
        })
        edges.push({
          id: `${anchor}=>${c.id}`,
          source: anchor,
          target: c.id,
          type: 'pipeline',
          data: { color: colorOf(c.name), active: c.id === runningId },
        })
      })
      anchor = g[g.length - 1]!.id
      x += TOOL_W + GAP
    })
  })

  return { nodes, edges }
}

function CanvasInner({ runLive, modelLabel }: { runLive: RunLive; modelLabel: string | null }) {
  const built = useMemo(() => buildGraph(runLive, modelLabel), [runLive, modelLabel])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(built.edges)
  const flow = useReactFlow()
  /** 相机策略：执行中新节点 → 平移跟随（保持当前缩放）；本轮完成（working true→false）→ fitView 全景 */
  const countRef = useRef(-1)
  const wasWorkingRef = useRef(false)
  useEffect(() => {
    setNodes(built.nodes)
    setEdges(built.edges)
    const last = built.nodes[built.nodes.length - 1]
    if (built.nodes.length !== countRef.current) {
      countRef.current = built.nodes.length
      if (runLive.working && last) {
        // 跟随最新节点：平移到画布偏右位置（新节点入目但不缩放）
        const tx = last.position.x + 140
        const ty = last.position.y + 40
        window.setTimeout(() => void flow.setCenter(tx, ty, { duration: 500 }), 30)
      }
    }
    if (wasWorkingRef.current && !runLive.working) {
      // 本轮刚结束：全景收拢
      window.setTimeout(() => void flow.fitView({ padding: 0.12, duration: 600 }), 60)
    }
    wasWorkingRef.current = runLive.working
  }, [built, runLive.working, setNodes, setEdges, flow])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      fitView
      minZoom={0.15}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      className="ecn-flow"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} className="ecn-bg" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap pannable zoomable className="ecn-minimap" maskColor="rgba(0,0,0,0.25)" nodeColor={() => '#3a3630'} />
    </ReactFlow>
  )
}

export function ExecutionCanvas({ runLive, modelLabel }: { runLive: RunLive; modelLabel: string | null }) {
  return (
    <div className="ecn-wrap">
      <ReactFlowProvider>
        <CanvasInner runLive={runLive} modelLabel={modelLabel} />
      </ReactFlowProvider>
    </div>
  )
}
