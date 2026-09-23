/**
 * 创作指南弹窗：详细教学文档（从 0 到 1 写书流程 / 九大模式 / 资料系统 / 实用技巧）
 * + 「开启教学指引」入口（分步圈选页面功能 → GuideTour）。
 * 遮罩复用 .modal-mask；弹窗风格对齐设置中心（bg-panel / 金色点缀 / pop 入场）。
 */
import { useEffect } from 'react'
import { Icon } from './Icon.tsx'

/** 快速上手五步（编号卡片渲染） */
const QUICK_STEPS: Array<{ title: string; desc: string }> = [
  {
    title: '建书',
    desc: '欢迎页「新建小说」创建标准工程骨架（正文/大纲/设定/追踪），或直接打开已有的小说文件夹。',
  },
  {
    title: '讨论设定',
    desc: '切「讨论」模式聊想法：一句话梗概、主角、世界观、核心冲突。达成共识后 Agent 自动落盘到 设定/ 和 大纲/。',
  },
  {
    title: '开书',
    desc: '切「创作」模式说「开始写这本书」。Agent 按流程产出核心设定 → 全书大纲 → 逐章细纲，并默认停在细纲交付等你看。',
  },
  {
    title: '审纲放行',
    desc: '细纲是性价比最高的干预点——改细纲一行胜过改正文一章。确认后放行，Agent 开始写正文（单轮最多 3 章）。',
  },
  {
    title: '日更与打磨',
    desc: '每章自动走 13 步流程并过质检门禁；「审稿」出分级报告，「优化」去 AI 味。资料页的人物关系网随设定实时生长。',
  },
]

/** 九大模式速查 */
const MODE_ROWS: Array<{ mode: string; use: string; when: string }> = [
  { mode: '讨论', use: '新书讨论 / 大纲探讨 / 设定优化', when: '动笔前理清想法' },
  { mode: '创作', use: '长/短篇正文创作（核心工作流）', when: '写设定、大纲、正文' },
  { mode: '导入', use: '外部章节导入适配 + 追踪补录', when: '迁移旧稿续写' },
  { mode: '优化', use: '去 AI 味 / 文笔优化 / 大修', when: '成稿后打磨' },
  { mode: '审稿', use: '多视角审稿，S1-S4 分级报告', when: '交稿前体检' },
  { mode: '市场', use: '扫榜 / 拆文，产出对标资产', when: '选题与对标分析' },
  { mode: '预览', use: '阅读 / 听书 / 资料库（纯前端）', when: '不消耗 Agent 额度' },
  { mode: '同人', use: '原著设定 → 拆书 → 专属设定 → 细纲 → 创作', when: '写同人文' },
  { mode: '校准', use: '跨文件矛盾诊断与滞后内容修复', when: '多轮修订后设定/大纲失同步' },
]

const TIPS: string[] = [
  '正文一律落盘 正文/第NNN章_标题.md，质检门禁通过且追踪提交成功才算一章完成。',
  '输入框支持 @文件引用（把设定/章节喂给 Agent）与「+」菜单附件。',
  '阅读视图勾「跟随 Agent」，新章过门禁后自动跳转展示。',
  '每 3 章让 Agent 跑一次 tracking check 快照，方向偏了及时纠。',
  '追踪库是程序派生的只读视图，不要手改；设定/大纲可直接编辑。',
  'Ctrl+Alt+N 开新会话；会话按模式独立保存，随时回来继续。',
]

export function GuideModal({
  onClose,
  onStartTour,
}: {
  onClose: () => void
  onStartTour: () => void
}): React.JSX.Element {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="guide-hub" role="dialog" aria-modal="true" aria-label="创作指南">
        <header className="guide-head">
          <span className="guide-title">
            <Icon name="guide" size={16} /> 创作指南
          </span>
          <span className="guide-sub">从 0 到 1 用 Agent 写一本小说</span>
          <button type="button" className="drawer-close" title="关闭（Esc）" aria-label="关闭指南" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="guide-body">
          {/* 一、快速上手 */}
          <section className="guide-sec">
            <h3>
              <i>01</i> 快速上手：五步写出第一本书
            </h3>
            <div className="guide-steps">
              {QUICK_STEPS.map((s, i) => (
                <div key={s.title} className="guide-step">
                  <span className="guide-step-no">{i + 1}</span>
                  <div>
                    <b>{s.title}</b>
                    <p>{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 二、模式速查 */}
          <section className="guide-sec">
            <h3>
              <i>02</i> 九大模式速查
            </h3>
            <table className="guide-table">
              <thead>
                <tr>
                  <th>模式</th>
                  <th>用途</th>
                  <th>什么时候用</th>
                </tr>
              </thead>
              <tbody>
                {MODE_ROWS.map((r) => (
                  <tr key={r.mode}>
                    <td className="guide-td-mode">{r.mode}</td>
                    <td>{r.use}</td>
                    <td className="guide-td-when">{r.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 三、资料与关系网 */}
          <section className="guide-sec">
            <h3>
              <i>03</i> 设定资料与人物关系网
            </h3>
            <p className="guide-p">
              右侧可视化栏「资料」页分三库：<b>大纲 / 设定 / 追踪</b>（追踪为只读派生视图）。「设定」页顶部的人物关系网由{' '}
              <code>设定/关系.md</code> 的「关系总览」表格自动解析：节点大小 = 角色卡丰富度，悬停看关系，点节点开角色卡，右键传头像。数据缺失时点「让
              Agent 补建」一键生成标准格式。
            </p>
          </section>

          {/* 四、实用技巧 */}
          <section className="guide-sec">
            <h3>
              <i>04</i> 实用技巧
            </h3>
            <ul className="guide-tips">
              {TIPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="guide-foot">
          <span className="guide-foot-hint">第一次用？跟着高亮走一遍界面，约 1 分钟</span>
          <div className="guide-foot-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              先看看文档
            </button>
            <button type="button" className="guide-tour-btn" onClick={onStartTour}>
              <Icon name="spark" size={13} /> 开启教学指引
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
