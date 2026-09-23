/**
 * 千问（qianwen.com，阿里）站点适配器 —— M3 第二站点。
 *
 * 选择器来源：2026-09-03 内置浏览器实测踩点固化（agent-browser CDP 直测）：
 * - 输入框：Slate contenteditable `[data-slate-editor]`（非 textarea）。
 *   ⚠️ 实测：`innerText=` 赋值与 `execCommand('insertText')` 都不同步 React/Slate 状态（发送按钮恒 disabled）；
 *   **只有派发 `paste` 事件（DataTransfer text/plain）能真正写入并点亮发送**。
 *   ⚠️ 二次实测（多行 prompt 翻车根因）：`execCommand('selectAll')+delete` 清空会**永久破坏** Slate 的
 *   paste 处理（之后任何 paste 都不生效）——严禁用 execCommand 清空；ask_ai 每次任务先导航干净 /chat，
 *   编辑器非空即视为本次已填入（幂等重试），绝不重复 paste。
 * - 发送：`button[aria-label="发送消息"]`，填入后由 disabled→enabled，CDP 可信点击生效（实测 URL 跳 /chat/<会话id>）。
 * - 发送成功：编辑器清空（textContent 回到 placeholder「向千问提问」）。
 * - 完成信号：**停止按钮法**——生成中有 `button[aria-label="停止回答"]`，消失且答案非空即 done。
 * - 提取：最后一轮 `.answer-common-card` 的 `:scope > .markdown-pc-special-class`（正文），
 *   思考稿在兄弟块 `.mb-4 > .thinkingContent-*` 内（`grid-rows-[0fr] opacity-0` 折叠），正文 md 不在其中，天然剥离。
 * - 登录判定：编辑器存在 && 页面无「登录」字样。
 * - 模型切换：顶部下拉为 Radix portal（选项类名 hash 化，CSS/XPath 均不可靠）。
 *   ⚠️ 实测：localStorage['qianwen-selectModel'] 写值 + reload **不生效**（恢复源不止 LS，勿用）；
 *   可靠路径 = 纯 eval 合成点击：触发器（class 含 hover:bg-tag 且文本 /^Qwen/）点开菜单 →
 *   选项（class 含 group+cursor-pointer+rounded-8 且首行 /^Qwen/）按名匹配 click → 触发器文案即时更新（无需 reload）。
 *   默认模型 Qwen3.8-Max（用户要求：站点默认 3.7 需切换）。
 * 站点改版时只需改本文件常量。重新踩点：browser_cdp open → eval 探测。
 */
import type { SiteAdapter } from '../adapters.ts'

export const qwenAdapter: SiteAdapter = {
  id: 'qwen',
  name: '千问 Qwen',
  homeUrl: 'https://www.qianwen.com/chat',

  // 可选模型（顶部下拉实测四项）；默认 3.8-Max
  models: ['Qwen3.8-Max', 'Qwen3.7-Max', 'Qwen3.7-千问', 'Qwen3.6-Flash'],
  defaultModel: 'Qwen3.8-Max',

  // 已登录：Slate 输入框存在且页面无「登录」入口字样
  checkLoginJs: `!!document.querySelector('[data-slate-editor]') && !document.body.innerText.includes('登录')`,

  // 导航到 /chat 本身即全新会话（实测 rounds=0），无需单独新建按钮
  newChatSelector: undefined,

  // 模型切换：纯 eval 合成点击（实测 Radix 下拉认可合成事件，无需可信点击/reload）。
  // 已是目标模型返回 'already'；成功返回 'ok'；失败返回错误串。
  setModelJs: `async (model) => {
    const readTrig = () => {
      const t = [...document.querySelectorAll('div')].find(
        (e) => /hover:bg-tag/.test(e.className) && /^Qwen/.test((e.innerText || '').trim()) && e.innerText.trim().length < 20,
      )
      return t ? t.innerText.trim() : null
    }
    document.body.click()
    await new Promise((r) => setTimeout(r, 300))
    if (readTrig() === model) return 'already'
    const trig = [...document.querySelectorAll('div')].find(
      (e) => /hover:bg-tag/.test(e.className) && /^Qwen/.test((e.innerText || '').trim()) && e.innerText.trim().length < 20,
    )
    if (!trig) return 'no-model-trigger'
    trig.click()
    await new Promise((r) => setTimeout(r, 600))
    const opts = [...document.querySelectorAll('div')].filter(
      (e) => /group/.test(e.className) && /cursor-pointer/.test(e.className) && /rounded-8/.test(e.className) && /^Qwen/.test((e.innerText || '').trim()) && e.innerText.length < 80,
    )
    const hit = opts.find((e) => e.innerText.trim().split('\\n')[0] === model)
    if (!hit) {
      document.body.click()
      return 'no-option:' + JSON.stringify(opts.map((e) => e.innerText.trim().split('\\n')[0]))
    }
    hit.click()
    await new Promise((r) => setTimeout(r, 600))
    return readTrig() === model ? 'ok' : 'verify-fail:' + String(readTrig())
  }`,

  fillPromptJs: `async (prompt) => {
    const t = document.querySelector('[data-slate-editor]')
    if (!t) return 'no-input'
    const norm = (s) => (s || '').replace(/[\\u200b\\ufeff]/g, '').trim()
    const cur = norm(t.textContent)
    const ph = norm(t.getAttribute('data-placeholder'))
    // 幂等：已有内容（重试路径）——ask_ai 每次任务先导航干净 /chat，编辑器里的内容只可能是本次 paste 的，
    // 非空即视为已填入（发送失败重试时直接再点发送，不重复 paste 造成追加）。
    if (cur && cur !== ph) return 'filled'
    t.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', prompt)
    t.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
    await new Promise((r) => setTimeout(r, 400))
    if (!norm(t.textContent) || norm(t.textContent) === ph) return 'input-empty'
    return 'filled'
  }`,

  sendSelector: 'button[aria-label="发送消息"]',

  // 发送成功 = 编辑器回到 placeholder（清空）
  sendVerifyJs: `(() => {
    const t = document.querySelector('[data-slate-editor]')
    const raw = (t?.textContent || '').replace(/[\\u200b\\ufeff]/g, '').trim()
    const ph = (t?.getAttribute('data-placeholder') || '').trim()
    return raw === '' || raw === ph
  })()`,

  // 停止按钮消失 + 最后一轮正文非空 = done；生成中标志 / 空 = generating；末轮含报错文案 = error
  pollStateJs: `(() => {
    if (document.querySelector('button[aria-label="停止回答"]')) return 'generating'
    const cards = [...document.querySelectorAll('.answer-common-card')]
    if (!cards.length) return 'generating'
    const last = cards[cards.length - 1]
    const txt = last.innerText || ''
    if (/生成失败|网络异常|请求过于频繁|出了点问题|请稍后重试/.test(txt)) return 'error'
    const md = last.querySelector(':scope > .markdown-pc-special-class')
      || [...last.querySelectorAll('.markdown-pc-special-class')].find((e) => !e.closest('[class*="thinkingContent"]'))
    return (md?.innerText || '').trim().length > 0 ? 'done' : 'generating'
  })()`,

  // 提取最后一轮正文（排除 thinkingContent 折叠区），剥净站点包装
  extractJs: `(() => {
    const cards = [...document.querySelectorAll('.answer-common-card')]
    if (!cards.length) return ''
    const last = cards[cards.length - 1]
    const md = last.querySelector(':scope > .markdown-pc-special-class')
      || [...last.querySelectorAll('.markdown-pc-special-class')].find((e) => !e.closest('[class*="thinkingContent"]'))
    let lines = (md?.innerText || '').trim().split('\\n')
    const head = () => lines[0]?.trim() ?? ''
    while (lines.length && (/^(深度思考已完成|深度思考|思考中|已深度思考)$/.test(head()) || head() === '')) lines.shift()
    return lines.join('\\n').trim()
  })()`,
}
