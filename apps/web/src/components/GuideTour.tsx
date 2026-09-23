/**
 * 分步教学指引（Tour）：聚光灯圈选页面功能 + 步骤卡片逐步讲解。
 * - 聚光实现：spot 元素套 0 0 0 200vmax 巨型 box-shadow 当遮罩，随目标 rect 平滑移动；
 * - 步骤卡片自动落位（目标下方，放不下则上方；无目标步骤居中）；
 * - 全屏 blocker 拦截误触；Esc 退出、←/→ 切步；resize/scroll 实时跟随重测。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

interface TourStep {
  /** 圈选目标的 CSS 选择器；undefined = 居中卡片（无聚光） */
  target?: string
  title: string
  desc: string
}

const STEPS: TourStep[] = [
  {
    title: '欢迎使用 Story Studio',
    desc: '这份分步指引带你走一遍核心功能区，约 1 分钟。可随时按 Esc 或「跳过教程」退出，也可以用 ← / → 键切换步骤。',
  },
  {
    target: '.ab-modes',
    title: '模式切换',
    desc: '左侧七个图标是七种工作模式：讨论 / 创作 / 导入 / 优化 / 审稿 / 市场 / 预览。Agent 在不同模式下使用不同的流程与工具——新手从「讨论」开始，用「创作」写正文。',
  },
  {
    target: '.sidepanel',
    title: '侧面板',
    desc: '显示当前模式的说明、快捷切换与历史会话。每个会话独立保存，随时回来继续；「＋ 新会话」快捷键 Ctrl+Alt+N。',
  },
  {
    target: '.chat-panel',
    title: '对话区',
    desc: '与 Agent 对话的主区域，用大白话描述需求即可。Agent 会通过工具直接读写你的小说工程文件；可展开「任务执行过程」查看每一步工具调用与思考。',
  },
  {
    target: '.composer-main',
    title: '输入区',
    desc: '支持 @文件引用（把设定/章节喂给 Agent）、「+」菜单附件与网页 AI 通道。写正文时 Agent 自动走单章 13 步流程并触发质检门禁。',
  },
  {
    target: '.work-panel',
    title: '可视化栏',
    desc: '右侧七大视图：工作流（实时执行画布）/ 阅读（手机阅读器）/ 资料（设定卡墙 + 人物关系网）/ 追踪 / 导入 / 优化 / 报告。',
  },
  {
    target: '.wp-view-tabs',
    title: '视图切换 · 重点看「资料」',
    desc: '「资料」页的人物关系网由 设定/关系.md 的「关系总览」表格自动解析：点角色节点开设定卡，右键可上传头像；数据缺失时可一键「让 Agent 补建」。',
  },
  {
    target: '.ab-bottom',
    title: '底部工具',
    desc: '资源管理器（工程文件树）、书架（多书切换）、创作指南（本教学）与模型设置都在这里。',
  },
  {
    target: '.status-bar',
    title: '状态栏',
    desc: '底部实时显示连接状态、上下文占用与日志入口——Agent 出问题先看这里。',
  },
  {
    title: '开始你的第一本书',
    desc: '推荐流程：讨论模式定设定 → 创作模式开书（停在细纲交付）→ 审后放行日更（每轮 ≤3 章）→ 审稿/优化打磨。祝你创作愉快！',
  },
]

/** 聚光框外扩边距 */
const SPOT_PAD = 8
/** 卡片宽度 */
const CARD_W = 340

export function GuideTour({ onFinish }: { onFinish: () => void }): React.JSX.Element {
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const rafRef = useRef(0)
  const step = STEPS[idx]!

  const next = useCallback(() => {
    if (idx >= STEPS.length - 1) onFinish()
    else setIdx(idx + 1)
  }, [idx, onFinish])
  const prev = useCallback(() => setIdx((v) => Math.max(0, v - 1)), [])

  /** 测量当前目标（scrollIntoView 后 rAF 取 rect，避免过渡帧坐标） */
  const measure = useCallback(() => {
    const t = step.target
    if (!t) {
      setRect(null)
      return
    }
    const el = document.querySelector<HTMLElement>(t)
    if (!el) {
      setRect(null)
      return
    }
    setRect(el.getBoundingClientRect())
  }, [step.target])

  useLayoutEffect(() => {
    const t = step.target
    if (t) {
      document.querySelector<HTMLElement>(t)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(rafRef.current)
  }, [measure, step.target])

  // resize / 任意容器滚动 → 跟随重测（rAF 节流）
  useEffect(() => {
    const onMove = (): void => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
      cancelAnimationFrame(rafRef.current)
    }
  }, [measure])

  // 键盘：Esc 退出 / ← → 切步
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onFinish()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, onFinish, prev])

  // 卡片落位：有目标 → 下方优先（放不下则上方）；无目标 → 视口居中
  let cardStyle: React.CSSProperties
  if (rect) {
    const spotBottom = rect.bottom + SPOT_PAD
    const below = spotBottom + 14 + 190 <= window.innerHeight
    const top = below ? spotBottom + 14 : Math.max(12, rect.top - SPOT_PAD - 14 - 190)
    const left = Math.min(
      window.innerWidth - CARD_W - 12,
      Math.max(12, rect.left + rect.width / 2 - CARD_W / 2),
    )
    cardStyle = { top, left, width: CARD_W }
  } else {
    cardStyle = {
      top: '50%',
      left: '50%',
      width: CARD_W,
      transform: 'translate(-50%, -50%)',
    }
  }

  return (
    <div className="gtour" role="dialog" aria-label="教学指引">
      {/* 拦截误触（透明全屏，在聚光层之下） */}
      <div className="gt-blocker" onClick={onFinish} aria-hidden />

      {/* 聚光框：巨型 box-shadow 充当遮罩；无目标步骤用纯遮罩 */}
      {rect ? (
        <div
          className="gt-spot"
          style={{
            top: rect.top - SPOT_PAD,
            left: rect.left - SPOT_PAD,
            width: rect.width + SPOT_PAD * 2,
            height: rect.height + SPOT_PAD * 2,
          }}
          aria-hidden
        />
      ) : (
        <div className="gt-dim" aria-hidden />
      )}

      {/* 步骤卡片 */}
      <div className="gt-card" style={cardStyle}>
        <div className="gt-card-head">
          <span className="gt-step-no">
            {idx + 1} / {STEPS.length}
          </span>
          <button type="button" className="gt-skip" onClick={onFinish}>
            跳过教程 ✕
          </button>
        </div>
        <h4 className="gt-title">{step.title}</h4>
        <p className="gt-desc">{step.desc}</p>
        <div className="gt-actions">
          <div className="gt-dots" aria-hidden>
            {STEPS.map((_, i) => (
              <i key={i} className={i === idx ? 'on' : i < idx ? 'done' : ''} />
            ))}
          </div>
          <div className="gt-btns">
            {idx > 0 && (
              <button type="button" className="gt-btn ghost" onClick={prev}>
                上一步
              </button>
            )}
            <button type="button" className={`gt-btn${idx === STEPS.length - 1 ? ' primary' : ''}`} onClick={next}>
              {idx === STEPS.length - 1 ? (
                <>
                  <Icon name="check-circle" size={13} /> 完成
                </>
              ) : (
                '下一步'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
