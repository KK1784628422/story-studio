/**
 * 网页 AI 站点适配器契约（FR-1）：每个站点一组可配置动作，ask_ai 工具据此驱动内置浏览器。
 * 新增站点 = 在 sites/ 下加一个适配器文件并注册到 SITE_ADAPTERS，核心逻辑零改动。
 *
 * 契约说明：
 * - checkLoginJs / fillPromptJs / pollStateJs / extractJs 是「页面内 eval 表达式」（base64 通道执行）；
 * - newChatSelector / sendSelector 走 agent-browser click（CDP 可信点击）——
 *   ⚠️ 实测：chatglm 等站点忽略合成 MouseEvent（React 只认可信事件），发送按钮必须可信点击；
 * - fillPromptJs：函数体 `async (prompt) => ...`，一次性注入整段 prompt（原生 setter + input 事件），
 *   返回 'filled'=填入成功，其余字符串=错误原因。严禁逐键分段输入（旧架构实测会触发网页 AI 中断）。
 */
export interface SiteAdapter {
  /** 站点 id（ask_ai 入参 site 的取值） */
  id: string
  /** 展示名（错误提示/日志用） */
  name: string
  /** 对话页 URL */
  homeUrl: string
  /** eval：返回 true=已登录 / false=未登录 */
  checkLoginJs: string
  /** 新建会话按钮 CSS 选择器（可信点击；无则 undefined 跳过） */
  newChatSelector?: string
  /** eval 函数体：填入 prompt，返回 'filled' 或错误原因 */
  fillPromptJs: string
  /** 发送按钮 CSS 选择器（可信点击） */
  sendSelector: string
  /** eval：发送成功判定（通常=输入框已清空），返回 true/false */
  sendVerifyJs: string
  /** eval：返回 'generating'（生成中）/ 'done'（完成）/ 'error'（页面报错） */
  pollStateJs: string
  /** eval：返回最后一条 assistant 回答的纯文本（string） */
  extractJs: string
  /** 可选模型列表（站点支持用户选模型时填；ask_ai 入参 model 的取值域，展示给 Agent/用户） */
  models?: string[]
  /** 站点默认模型（用户未指定 model 时用它；缺省=不主动切换模型） */
  defaultModel?: string
  /** eval 函数体：`async (model) => 'ok' | 'already' | 错误串`——把选中模型切到站点当前生效（自包含开菜单/选项/自校验），编排层据此判成败 */
  setModelJs?: string
}

import { glmAdapter } from './sites/glm.ts'
import { qwenAdapter } from './sites/qwen.ts'

/** 站点注册表：key = site id。M1 内置 GLM；M3 扩展千问 */
export const SITE_ADAPTERS: Record<string, SiteAdapter> = {
  [glmAdapter.id]: glmAdapter,
  [qwenAdapter.id]: qwenAdapter,
}

export const DEFAULT_SITE = glmAdapter.id

export function getAdapter(site?: string): { adapter?: SiteAdapter; error?: string } {
  const id = site?.trim() || DEFAULT_SITE
  const adapter = SITE_ADAPTERS[id]
  if (!adapter) {
    return { error: `未知站点「${id}」。可用站点：${Object.values(SITE_ADAPTERS).map((a) => `${a.id}（${a.name}）`).join('、')}` }
  }
  return { adapter }
}
