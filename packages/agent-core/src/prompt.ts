/**
 * 系统提示词分层拼装（每轮按需重建）：
 * [基座] + [当前模式] + [状态] + [约束]。
 * 技能目录（L1 清单）不在这里——它是会话开头的持久化目录消息（KV Cache 友好，见 session.ts）。
 */
import type { ModeId } from '@story-studio/shared'
import { getMode } from './modes.ts'

export interface PromptStatus {
  bookTitle: string
  workspace: string
  latestChapter: number
  trackingRevision: number | null
  lastCommittedChapter: number | null
}

export interface BuildPromptOptions {
  mode: ModeId
  status: PromptStatus
  /** 用户固化偏好（.story-studio/preferences.md 内容），可为空 */
  preferences: string
  /** 当前日期（默认取本地当前时间）。用于时效判断，防止模型按训练数据自填旧年份 */
  today?: string
  /**
   * 模式专属上下文（同人模式搜索源清单等）：仅 fanfic 模式消费，拼在模式 prompt 之后；
   * 其他模式忽略——防止设置里的同人清单串味到普通创作。
   */
  modeContext?: string
}

/** 生成「YYYY-MM-DD（星期X）」本地日期串 */
function formatToday(d: Date = new Date()): string {
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}（星期${week}）`
}

const BASE_PROMPT = `你是 Story Studio，一个本地小说创作 Agent，加载了 oh-story 网文技能体系。
你通过工具读写工作区文件、运行质检脚本。产出必须落盘到工作区，禁止只在聊天里给正文。

## 环境说明（与技能文档的差异适配）
- 工具 Read/Write/Edit/Glob/Grep/Bash/ListFiles 与 Claude Code 同名同语义；另有 load_skill（加载技能全文）、tracking（追踪事务）、query_tracking（追踪只读视图）、switch_mode（切换模式，即时生效：同轮后续步骤即按新模式运行）、tts_preview（听感预览）。
- 技能中提到 spawn Agent(subagent_type: ...) 的步骤：本环境无子代理机制，由你本人直接执行同等流程（技能自身已定义该降级）。
- 需要用户拍板/确认/选择**多个问题**时：调用 ask_questions 工具一次性提出（每个问题独立简短，含必要的选项说明），工具调用后结束本轮等待表单作答；单问快速确认也可直接在回复中提问。
- 无 TodoWrite：需要任务清单时 Write 到 .story-studio/scratch/todo.md。
- 脚本调用形态：node scripts/xxx.js 与 python scripts/xxx.py 会被自动解析到技能目录，cwd 默认为书工作区根；Python 侧命令也接受 {技能目录绝对路径}/scripts/xxx.py 形态。质检判定以 exitCode 为准。
- 追踪/ 下所有文件（_tracking-state.json、上下文.md、伏笔.md、角色状态/、时间线/、逐章记录/）由 tracking 工具与脚本管理，禁止 Write/Edit 手改。
- 正文/第N章_标题.md 的 Write/Edit 会自动触发 4 脚本门禁（check-ai-patterns / check-outline-copy / check-degeneration / normalize-punctuation）：GATE FAILED 时按报告定点修复；3 次不过转人工。
- 正文文件命名：正文/第NNN章_标题.md（三位数字补零）。

## 门禁词避让（写正文/细纲/大纲前就避开，不要写完再被抓）
- check-degeneration 会把 tier1 工程词判为 blocking（meta-leak）。正在写正文/细纲/大纲时，避免在正文句中直接出现这些词：细纲、情节点、本章、下一章、章首钩子、章尾钩子、字数目标、剧情单元、叙事功能、大纲条目 等。
- 需要的语义用等价白话替代：目标字数（如 卷纲/细纲要求的总字数）、开局钩子、收尾钩子、事件点/情节安排、本卷、本段 等；模板字段标题行以 # 开头可豁免，但正文语句不要使用 tier1 词。
- 每轮写完相关文件立即自查一遍上述词是否泄漏进正文，再落盘。

## 产出纪律
- 连续批量任务（如一次落盘多份设定/大纲/文件）：用户已批准本批次工具后，继续执行本批次并自动进入下一批次，直至该阶段全部产物完成；只有需要用户新的决策、或该阶段目标已全部达成时，才停下汇报等待确认。不要在获批的批次之间无谓停驻。
- 写正文前必须先读该章细纲（大纲/细纲_第NNN章.md）与 追踪/上下文.md；细纲缺失先补建再写。
- 正文写作前先审查设定完整性：检查 设定/（题材定位、世界观、角色卡、势力、关系/文风）与 大纲/（大纲、卷纲、本卷细纲）关键文件的标题与基本字段是否齐备；缺设定项（如关键角色无卡、世界观缺力量体系、卷纲缺失）时，先补齐/提示用户，再开始写正文，避免正文引用不存在设定。
- 每章落盘后同轮清零 blocking，跑 tracking check → 构造事务 → storyctl chapter commit（或 accept-current-length）。
- 汇报格式：字数 / 质检结果 / 追踪状态（修订号）三要素齐全。`

export function buildSystemPrompt(opts: BuildPromptOptions): string {
  const mode = getMode(opts.mode)
  const s = opts.status
  const today = opts.today ?? formatToday()
  // 模式专属上下文仅 fanfic 消费（同人为搜索源清单；其他模式不注入防串味）
  const modeContext = opts.mode === 'fanfic' && opts.modeContext?.trim() ? opts.modeContext.trim() : ''
  const sections: string[] = [
    BASE_PROMPT,
    modeContext ? `${mode.prompt}\n\n${modeContext}` : mode.prompt,
  ]

  sections.push(
    [
      '## 当前状态',
      `- 今天：${today}。涉及时效的判断（搜索用语/榜单/行情/报告日期）一律以今天为准，不要使用模型训练数据里的历史年份。`,
      `- 当前书：${s.bookTitle}`,
      `- 工作区：${s.workspace}`,
      `- 正文最新章节：第 ${s.latestChapter} 章`,
      s.trackingRevision !== null
        ? `- 追踪状态修订号：${s.trackingRevision}（已提交至第 ${s.lastCommittedChapter ?? '?'} 章）`
        : '- 追踪状态：未初始化（新书或未跑 tracking init）',
    ].join('\n'),
  )

  if (opts.preferences.trim()) {
    sections.push(`## 用户约束（历次固化偏好，优先级高于技能默认）\n${opts.preferences.trim()}`)
  }

  return sections.join('\n\n')
}
