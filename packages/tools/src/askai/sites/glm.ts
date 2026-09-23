/**
 * GLM 智谱清言（chatglm.cn）站点适配器 —— M1 首选站点。
 *
 * 选择器来源：2026-08-30 内置浏览器实测踩点固化（agent-browser CDP 直测）：
 * - 输入框：页面唯一 textarea，原生 setter + input 事件注入生效（React 受控组件）
 * - 发送：img.enter_icon 必须 CDP 可信点击（合成 MouseEvent 被忽略，实测）
 * - 发送成功：textarea 清空 + URL 出现 cid=<会话id>
 * - 完成信号：每轮回答完成后新增一个 .regenerate-part-container（重新生成按钮容器）；
 *   生成中 .answer-content 文本流式增长（含思考内容，完成后回落为纯答案）
 * - 提取：最后一个 .answer .answer-content，开头有 "ChatGLM\n思考结束\n" 两行需剥离
 * 站点改版时只需改本文件常量。重新踩点：browser_cdp open → snapshot/eval 探测。
 */
import type { SiteAdapter } from '../adapters.ts'

export const glmAdapter: SiteAdapter = {
  id: 'glm',
  name: '智谱清言 GLM',
  homeUrl: 'https://chatglm.cn/',

  // 已登录：输入框存在且页面无「登录」入口字样（未登录会显示登录按钮/遮罩）
  checkLoginJs: `!!document.querySelector('textarea') && !document.body.innerText.includes('登录')`,

  newChatSelector: 'div.new-session',

  fillPromptJs: `async (prompt) => {
    const t = document.querySelector('textarea')
    if (!t) return 'no-input'
    t.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(t, prompt)
    t.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    if (!t.value || t.value.trim().length === 0) return 'input-empty'
    return 'filled'
  }`,

  sendSelector: 'img.enter_icon',

  sendVerifyJs: `(document.querySelector('textarea')?.value ?? '').trim().length === 0`,

  // 完成 = 最后一轮 .answer 之后已出现属于它的 .regenerate-part-container；
  // 简化判定：.answer 面板数 N 与 .regenerate-part-container 数相等即本轮完成
  // （每轮回答完成才追加一个 regen 容器；生成中 regen 数 = 面板数 - 1）
  pollStateJs: `(() => {
    if (document.body.innerText.includes('生成失败') || document.body.innerText.includes('网络异常')) return 'error'
    const panels = document.querySelectorAll('.answer').length
    if (panels === 0) return 'generating'
    const regens = document.querySelectorAll('.regenerate-part-container').length
    return regens >= panels ? 'done' : 'generating'
  })()`,

  // 提取最后一轮回答：
  // ① 剥标记行（ChatGLM / 思考结束 等）与空行
  // ② 剥「思考稿/规划前缀」：GLM 深度思考长任务会把英文规划写在正文开头
  //    （如 "Let me carefully plan this chapter..."，实测 2026-08-30 二次调用出现 30K 思考稿）。
  //    判定：非中文开头且 ASCII 占该行一半以上 → 视为思考稿前缀剥离，直到遇到中文正文
  extractJs: `(() => {
    const list = [...document.querySelectorAll('.answer .answer-content')]
    if (!list.length) return ''
    let lines = (list[list.length - 1].innerText || '').trim().split('\\n')
    const head = () => lines[0]?.trim() ?? ''
    const asciiRatio = (s) => (s.match(/[\\x00-\\x7F]/g) || []).length / s.length
    while (lines.length && (/^(ChatGLM|思考结束|思考完毕|深度思考|已深度思考|思考过程|展开思考)$/.test(head()) || head() === '')) lines.shift()
    let eaten = 0
    while (lines.length && eaten < 24) {
      const h = head()
      if (!h || (!/^[\\u4e00-\\u9fff]/.test(h) && asciiRatio(h) > 0.5)) { lines.shift(); eaten++; continue }
      break
    }
    while (lines.length && head() === '') lines.shift()
    return lines.join('\\n').trim()
  })()`,
}
