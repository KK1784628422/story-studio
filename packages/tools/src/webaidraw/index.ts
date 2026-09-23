/**
 * webai_draw 工具：网页 AI 生图通道（人物头像）——把「填提示词→发送→等图→下载→配置头像」
 * 整段确定性交互代码化，Agent 一次调用完成全流程（与 ask_ai 同哲学：浏览器操作零暴露）。
 *
 * 编排链：detect → lockEmbeddedTab → 导航豆包 → checkLogin（未登录走红光圈人工接管链）
 *        → 填入生图 prompt（contenteditable）→ 可信点击发送 → 轮询图片生成完成
 *        → 提取图片 URL → 页面上下文 fetch 转 base64 → 写 设定/头像/{人物名}.{ext}（自动清旧格式）。
 * 全程 abort 可中断；任何失败返回结构化错误（Agent 引导重试或告知用户）。
 *
 * ⚠ 豆包选择器为合理初版（2026-09 按豆包网页版常见结构编写），站点改版后需重新踩点：
 *   browser_cdp open doubao.com → snapshot/eval 探测，只改本文件常量。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContext } from '../context.ts'

/** 轮询间隔：图片生成慢（10-120s 常见），4s 一次足够 */
const POLL_INTERVAL_MS = 4_000
/** 登录等待上限（人工扫码，与 ask_ai 一致） */
const LOGIN_WAIT_MS = 300_000
/** 生图默认超时：豆包生图一般 10-120s，给 240s 余量 */
const DEFAULT_MAX_WAIT_MS = 240_000
/** 图片体积上限（与 /api/avatar 一致，防超限写盘） */
const MAX_IMG_BYTES = 5_000_000
/** 头像可写扩展（读序与 /api/avatar 一致） */
const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** 全程互斥锁：webai_draw 执行期间拒绝新调用（防模型一轮双调互踩浏览器 daemon） */
let drawInFlight = false

/** 人物名校验（与 /api/avatar 的 badAvatarName 同规则） */
const badName = (n: string): boolean => !n || n.length > 30 || /[\\/:*?"<>|]/.test(n) || n.includes('..')

/**
 * 豆包（doubao.com）生图站点常量。
 * 交互模型：对话框直接发含「画/生成图片」意图的 prompt，豆包自动进入生图流程；
 * 轮询=AI 回复区出现已加载完成的大图（naturalWidth>200 过滤头像/图标类小图）。
 */
const DOUBAO = {
  id: 'doubao',
  name: '豆包',
  homeUrl: 'https://www.doubao.com/chat/',

  // 已登录：存在输入框（textarea 或 contenteditable）且页面无「登录」按钮文案
  checkLoginJs: `(() => {
    const input = document.querySelector('textarea, [contenteditable="true"]')
    if (!input) return false
    const btns = [...document.querySelectorAll('button, a')]
    return !btns.some((b) => (b.innerText || '').trim() === '登录')
  })()`,

  // 填入 prompt：豆包输入框为 contenteditable（按序探测 textarea → contenteditable），
  // 原生 setter 对 textarea；contenteditable 用 execCommand('insertText')（触发 input 事件，React 可识别）
  fillPromptJs: `async (prompt) => {
    const ta = document.querySelector('textarea')
    if (ta) {
      ta.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, prompt)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      return (ta.value && ta.value.trim().length > 0) ? 'filled' : 'input-empty'
    }
    const ce = document.querySelector('[contenteditable="true"]')
    if (!ce) return 'no-input'
    ce.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    document.execCommand('insertText', false, prompt)
    await new Promise((r) => setTimeout(r, 300))
    return (ce.innerText && ce.innerText.trim().length > 0) ? 'filled' : 'input-empty'
  }`,

  // 发送按钮：多候选按序可信点击（豆包常见 data-testid + 语义类名；Enter 兜底在工具层）
  sendSelectors: ['[data-testid="send_button"]', '[data-testid="send-button"]', 'button[class*="send"]'],

  // 发送成功：输入框已清空
  sendVerifyJs: `(() => {
    const ta = document.querySelector('textarea')
    if (ta) return (ta.value ?? '').trim().length === 0
    const ce = document.querySelector('[contenteditable="true"]')
    return !ce || (ce.innerText ?? '').trim().length === 0
  })()`,

  // 发送前基线快照：全页 img 的 src/currentSrc/data-src 集合，写入 window.__avatarBase（归一化数组）。
  // ⚠ 实测坑①（2026-09-02 首测）：豆包欢迎页自带 intro 静态宣传图（421×360，已加载），
  //   旧版轮询扫描全页面，发送后首轮就把固有图当「生成完成」——发送前记基线，之后只认新增图。
  // ⚠ 实测坑②（2026-09-02 四测）：基线经工具层传参回页面会踩双层 JSON 解析
  //   （ev() 对字符串结果再 parse 一层：JSON.stringify(urls) 返回值实际变成数组，String() 后成
  //   "u1,u2" 非法 JSON）→ pollNewJs 每轮 JSON.parse 抛错 → evalFails 快速累积 → 误报
  //   「daemon 卡死」而豆包其实仍在生成。故基线改存 window 变量（一次写入，轮询零传参）。
  baselineJs: `(() => {
    const norm = (u) => String(u).replace(/\\?.*$/, '')
    const s = new Set()
    for (const i of document.querySelectorAll('img')) {
      for (const u of [i.src, i.currentSrc, i.getAttribute('data-src'), i.getAttribute('data-original')]) {
        if (u && /^https?:/.test(u)) s.add(norm(u))
      }
    }
    window.__avatarBase = [...s]
    return window.__avatarBase.length
  })()`,

  // 轮询探测（无参数，读 window.__avatarBase；含生成态判定，一次 eval 拿全状态——
  // 豆包生图期页面高频流式重渲染，eval 压力减半降低偶发超时）：
  //   ① 仅返回「基线之外」的生成图：强特征 URL 含 /rc_gen_image/（豆包图床固定路径）；
  //     兜底启发式=自然尺寸 ≥300 且显示尺寸 ≥100（滤推荐栏 320×320 但显示 20×20 的动态小图标）。
  //   ② 归一化 key（去 query 签名）去重与稳定判定——签名 URL 每次重渲染整批换新，
  //     按全文比较永不稳定（三测卡死根因）；同 key 留分辨率最高变体（1728 原图优先于 288 缩略）。
  //   ③ busy=页面「正在生成」文案或「停止」按钮存在（生成中仍可输入，输入框不可作信号）。
  // 返回 { imgs: [{src,key,w,nw,nh}], busy: boolean }
  pollNewJs: `(() => {
    const norm = (u) => String(u).replace(/\\?.*$/, '')
    const base = new Set(window.__avatarBase || [])
    const out = new Map()
    for (const i of document.querySelectorAll('img')) {
      const src = i.src || ''
      if (!/^https?:/.test(src) || src.includes('favicon')) continue
      const key = norm(src)
      if (base.has(key) || base.has(norm(i.currentSrc || 'x'))) continue
      if (!i.complete || i.naturalWidth === 0) continue
      const isGen = src.includes('/rc_gen_image/')
      // 兜底启发式额外排除豆包静态资源（/static/，如 intro 宣传图）——无基线复用模式下防固有图混入
      if (!isGen && !(i.naturalWidth >= 300 && i.naturalHeight >= 300 && i.clientWidth >= 100 && i.clientHeight >= 100 && !src.includes('/static/'))) continue
      const w = i.naturalWidth * i.naturalHeight
      const prev = out.get(key)
      if (!prev || prev.w < w) out.set(key, { src, key, w, nw: i.naturalWidth, nh: i.naturalHeight })
    }
    let busy = false
    if (/正在生成/.test(document.body.innerText || '')) busy = true
    else busy = [...document.querySelectorAll('button')].some((b) => {
      const t = (b.innerText || '') + (b.title || '') + (b.getAttribute('aria-label') || '')
      return /停止生成|停止响应/.test(t)
    })
    return { imgs: [...out.values()], busy }
  })()`,

  // 下载：页面上下文 fetch 图片 URL → blob → FileReader → base64 dataUrl（字节 CDN 一般放行 CORS）；
  // 失败回退 canvas 方案（crossOrigin 匿名 + toDataURL）；再失败由工具层 CDP 元素截图兜底。
  // ⚠ 实测（2026-09-02 豆包）：字节图床三条页面内读取路全封——fetch(credentials) TypeError /
  //   fetch(普通) 403（校验请求特征）/ canvas tainted（响应无 ACAO 头）；元素截图是唯一稳路。
  downloadJs: `async (url) => {
    try {
      const r = await fetch(url, { credentials: 'include' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const blob = await r.blob()
      if (blob.size === 0) throw new Error('empty blob')
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res(String(fr.result))
        fr.onerror = () => rej(new Error('read failed'))
        fr.readAsDataURL(blob)
      })
      return { ok: true, dataUrl }
    } catch (e1) {
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => res(im)
          im.onerror = () => rej(new Error('img load failed'))
          im.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d').drawImage(img, 0, 0)
        const dataUrl = canvas.toDataURL('image/png')
        return { ok: true, dataUrl }
      } catch (e2) {
        return { ok: false, error: String(e1 && e1.message || e1) + ' / ' + String(e2 && e2.message || e2) }
      }
    }
  }`,

  // ═══ 截图获取（五测定稿：v1 直接元素截图为主保完整，克隆·视口内最大化升级清晰度）═══
  // 演进史：v1 直接截（完整但 208×277 显示尺寸）→ v2 改原图样式放大（混网页杂质）→
  //   v3 克隆+自然尺寸+set viewport 放大视口（五测截图**不完整**：set viewport 在 Electron
  //   BrowserView 实测不可靠，视口没放大成功，1728×2304 克隆图被裁回原视口 1157×851 内）。
  // v4 结论：**任何情况下不动视口**。主路径保完整，升级路径在视口内做文章。

  // 主路径前置（v1）：目标 img 原样打 id——不改样式、不克隆。截图=元素显示区域（~208×277），
  // 分辨率低但**必定完整**（元素在视口内、无遮挡风险）。返回 {ok,nw,nh,vw,vh}（vw/vh=显示尺寸，0=不可见）
  shotMarkJs: `((src) => {
    const old = document.getElementById('__avatar_shot')
    if (old && old.dataset.avatarClone) old.remove()
    else if (old) old.id = ''
    document.getElementById('__avatar_backdrop')?.remove()
    const el = [...document.querySelectorAll('img')].find((i) => i.src === src)
    if (!el || !el.naturalWidth) return { ok: false }
    el.id = '__avatar_shot'
    return { ok: true, nw: el.naturalWidth, nh: el.naturalHeight, vw: el.clientWidth, vh: el.clientHeight }
  })`,

  // 升级路径前置（v4 克隆·视口内最大化）：克隆目标 img 到 body 根层（z-99999 置顶 + z-99998 白背板
  // 兜 PNG 透明区），按 min(自然尺寸, 视口-60) **等比渲染**——不动视口，规避 set viewport 不可靠；
  // 1728×2304 原图在 1157×851 视口下渲染约 593×791（比 v1 显示尺寸清晰 ~2.8 倍且完整）。
  // 克隆体带 data-avatar-clone 标记（restore 时区分：克隆体删、原图只摘 id，防误删页面原元素）。
  shotCloneJs: `((src) => {
    const el = [...document.querySelectorAll('img')].find((i) => i.src === src)
    if (!el || !el.naturalWidth) return { ok: false }
    if (el.id === '__avatar_shot') el.id = ''
    const nw = el.naturalWidth, nh = el.naturalHeight
    const scale = Math.min(1, (window.innerWidth - 60) / nw, (window.innerHeight - 60) / nh)
    const w = Math.max(1, Math.round(nw * scale)), h = Math.max(1, Math.round(nh * scale))
    const old = document.getElementById('__avatar_shot')
    if (old && old.dataset.avatarClone) old.remove()
    else if (old) old.id = ''
    document.getElementById('__avatar_backdrop')?.remove()
    const clone = el.cloneNode(false)
    clone.id = '__avatar_shot'
    clone.dataset.avatarClone = '1'
    clone.style.cssText = 'position:fixed;top:0;left:0;width:' + w + 'px;height:' + h + 'px;max-width:none;max-height:none;object-fit:contain;z-index:99999'
    const bd = document.createElement('div')
    bd.id = '__avatar_backdrop'
    bd.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:99998'
    document.body.appendChild(bd)
    document.body.appendChild(clone)
    return { ok: true, w, h }
  })`,

  // 克隆图是否已加载完成（缓存命中通常瞬时；未加载完截图会拍空白）
  cloneLoadedJs: `(() => {
    const el = document.getElementById('__avatar_shot')
    return !!el && el.dataset.avatarClone === '1' && el.complete && el.naturalWidth > 0
  })()`,

  // 收尾清理：背板删；id 元素是克隆体（data-avatar-clone）→ 删，是原图 → 只摘 id（不动页面 DOM）
  shotRestoreJs: `(() => {
    document.getElementById('__avatar_backdrop')?.remove()
    const el = document.getElementById('__avatar_shot')
    if (el) {
      if (el.dataset.avatarClone) el.remove()
      else el.id = ''
    }
    return true
  })()`,
}

export interface WebAiDrawResult {
  ok: boolean
  site?: string
  character?: string
  /** 落盘相对路径（ok=true 时存在） */
  path?: string
  bytes?: number
  /** 豆包侧图片 URL（下载失败时兜底暴露，供 Agent/用户手动处理） */
  imageUrl?: string
  needLogin?: boolean
  error?: string
}

export function createWebAiDrawTool(ctx: ToolContext) {
  const b = ctx.browser

  async function ev(js: string): Promise<unknown> {
    const r = await b.eval(js)
    if (!r.ok) throw new Error(`浏览器 eval 失败：${(r.stderr || r.raw || '未知错误').slice(0, 300)}`)
    return r.result
  }

  async function isLoggedIn(): Promise<boolean> {
    try {
      return (await ev(DOUBAO.checkLoginJs)) === true
    } catch {
      return false
    }
  }

  /** 未登录 → 红光圈人工接管（与 ask_ai 同链路） */
  async function waitForManualLogin(timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    ctx.events.emit({
      type: 'browser:login-required',
      message: `请在「Agent浏览器」面板完成 ${DOUBAO.name} 登录（扫码/密码均可），完成后流程自动恢复`,
    })
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        if (ctx.signalRef.current?.aborted) return { ok: false, error: '已被用户停止，登录流程中断' }
        if (await isLoggedIn()) return { ok: true }
        await sleep(3_000)
      }
      return { ok: false, error: `等待人工登录超时（${Math.round(timeoutMs / 1000)}s）。请登录后重试。` }
    } finally {
      ctx.events.emit({ type: 'browser:login-resolved' })
    }
  }

  /** 填入并发送：eval 注入 → 多候选可信点击发送 → 验证输入框清空 */
  async function fillAndSend(prompt: string): Promise<string | null> {
    const r = await ev(`(${DOUBAO.fillPromptJs})(${JSON.stringify(prompt)})`)
    if (r !== 'filled') return typeof r === 'string' ? `填入失败：${r}` : `填入脚本返回异常值：${JSON.stringify(r)}`
    let clicked = false
    for (const sel of DOUBAO.sendSelectors) {
      const c = await b.ab(['click', sel])
      if (c.ok) {
        clicked = true
        break
      }
    }
    if (!clicked) return `发送按钮点击失败（候选：${DOUBAO.sendSelectors.join(' / ')}）——豆包可能改版，需重新踩点`
    for (const t0 = Date.now(); Date.now() - t0 < 6_000; ) {
      try {
        if ((await ev(DOUBAO.sendVerifyJs)) === true) return null
      } catch {
        /* 页面变化中，重试 */
      }
      await sleep(600)
    }
    return '发送后输入框未清空（消息可能未发出）'
  }

  /** dataUrl → 写 设定/头像/{name}.{ext}（同名旧格式清理；返回相对路径） */
  function saveAvatar(name: string, dataUrl: string): { path: string; bytes: number } {
    const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(dataUrl)
    if (!m) throw new Error('图片格式不受支持（仅 png/jpeg/webp/gif）')
    return saveAvatarBuf(name, Buffer.from(m[2]!, 'base64'), m[1] === 'jpeg' ? 'jpg' : m[1]!)
  }

  /** Buffer → 写头像（saveAvatar 与截图兜底共用；ext 由调用方定） */
  function saveAvatarBuf(name: string, buf: Buffer, ext: string): { path: string; bytes: number } {
    if (buf.length === 0) throw new Error('图片内容为空')
    if (buf.length > MAX_IMG_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMG_BYTES / 1024 / 1024)}MB`)
    const dir = join(ctx.workspace, '设定', '头像')
    mkdirSync(dir, { recursive: true })
    for (const e of AVATAR_EXTS) {
      const old = join(dir, `${name}.${e}`)
      if (existsSync(old)) {
        try {
          unlinkSync(old)
        } catch {
          /* 旧格式残留不影响展示 */
        }
      }
    }
    const file = join(dir, `${name}.${ext}`)
    writeFileSync(file, buf)
    return { path: `设定/头像/${name}.${ext}`, bytes: buf.length }
  }

  /** PNG IHDR 尺寸解析（截图校验用：防截到空白/半张） */
  function pngSize(buf: Buffer): { w: number; h: number } | null {
    // PNG 签名 8B + chunk 长度 4B + IHDR 类型 4B（offset 12-16）+ 宽 4B + 高 4B
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }

  /**
   * CDP 元素截图获取头像（五测定稿 · 主路径保完整 + 升级路径提清晰）：
   *   阶段1 主路径（v1）：目标 img 原样打 id → 元素截图（显示尺寸 ~208×277）。
   *     元素在视口内无遮挡，**必定完整**——保底「最起码可以用」。
   *   阶段2 升级路径（v4 克隆·视口内最大化）：克隆到 body 根层，按 min(自然尺寸, 视口-60)
   *     等比渲染 → 截图（~593×791，清晰 ~2.8 倍）。⚠ 绝不动视口（set viewport 在 Electron
   *     BrowserView 实测不可靠，五测截图不完整的根因）。尺寸校验（≥期望 85%）通过且优于
   *     阶段1 才采用，否则保底版兜底。截图偶发 CDP 超时，各重试 1 次。
   */
  async function shotAvatar(name: string, src: string): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }> {
    const tmpDir = join(ctx.workspace, '.story-studio', 'tmp')
    const tmp1 = join(tmpDir, `avatar-shot-1-${Date.now()}.png`)
    const tmp2 = join(tmpDir, `avatar-shot-2-${Date.now()}.png`)
    try {
      mkdirSync(tmpDir, { recursive: true })

      // ── 阶段1 主路径：v1 直接元素截图（保完整）──
      const m1 = (await ev(`(${DOUBAO.shotMarkJs})(${JSON.stringify(src)})`)) as
        | { ok: boolean; nw?: number; nh?: number; vw?: number; vh?: number }
        | undefined
      if (!m1?.ok) return { ok: false, error: '页面上未找到目标图片元素（可能已被虚拟列表回收，重试可解）' }
      let shot1: Buffer | null = null
      if ((m1.vw ?? 0) > 0 && (m1.vh ?? 0) > 0) {
        let r = await b.ab(['screenshot', '#__avatar_shot', tmp1], 30_000)
        if (!r.ok) r = await b.ab(['screenshot', '#__avatar_shot', tmp1], 30_000)
        if (r.ok && existsSync(tmp1)) {
          const buf = readFileSync(tmp1)
          const sz = pngSize(buf)
          if (buf.length > 0 && sz && sz.w >= 100 && sz.h >= 100) shot1 = buf
        }
      }

      // ── 阶段2 升级路径：克隆·视口内最大化（失败不阻塞，保底版兜住）──
      let shot2: Buffer | null = null
      try {
        const m2 = (await ev(`(${DOUBAO.shotCloneJs})(${JSON.stringify(src)})`)) as
          | { ok: boolean; w?: number; h?: number }
          | undefined
        if (m2?.ok && (m2.w ?? 0) > 0 && (m2.h ?? 0) > 0) {
          // 等克隆图从缓存加载（≤5s，防拍空白）
          for (const t0 = Date.now(); Date.now() - t0 < 5_000; ) {
            try {
              if ((await ev(DOUBAO.cloneLoadedJs)) === true) break
            } catch {
              /* 重试 */
            }
            await sleep(400)
          }
          let r = await b.ab(['screenshot', '#__avatar_shot', tmp2], 30_000)
          if (!r.ok) r = await b.ab(['screenshot', '#__avatar_shot', tmp2], 30_000)
          if (r.ok && existsSync(tmp2)) {
            const buf = readFileSync(tmp2)
            const sz = pngSize(buf)
            // 尺寸校验：≥期望 85%（防空白/半张）且清晰度优于阶段1（面积比较）
            if (sz && sz.w >= (m2.w ?? 0) * 0.85 && sz.h >= (m2.h ?? 0) * 0.85) {
              const area1 = shot1 ? pngSize(shot1) : null
              if (!area1 || sz.w * sz.h > area1.w * area1.h) shot2 = buf
            }
          }
        }
      } catch {
        /* 升级失败保底版兜住 */
      }

      const best = shot2 ?? shot1
      if (!best) return { ok: false, error: '元素截图未产出有效文件（页面可能正在重渲染，稍后重试）' }
      if (best.length > MAX_IMG_BYTES) return { ok: false, error: `截图文件异常（${best.length} 字节）` }
      const saved = saveAvatarBuf(name, best, 'png')
      return { ok: true, path: saved.path, bytes: saved.bytes }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      for (const f of [tmp1, tmp2]) {
        try {
          if (existsSync(f)) unlinkSync(f)
        } catch {
          /* 临时文件清理失败无害 */
        }
      }
      try {
        await ev(DOUBAO.shotRestoreJs)
      } catch {
        /* 清理失败无害 */
      }
    }
  }

  return tool({
    description:
      '网页 AI 生图通道（人物头像，豆包 doubao.com）：把生图提示词交给豆包网页版生成人物头像图片，自动等待生成完成、下载图片并配置到对应人物（写 设定/头像/{人物名}，人物关系网/角色卡自动刷新）。调用前先按所用头像技能的提示词规范生成英文主提示词（1.0 走 novel-character-prompt 七段式；2.0 走 story-webai-avatar-2 的摄影笔记式模板；3.0 走 story-webai-avatar-3 的三段流水线转译模板）。⚠ 全程互斥：同一时间只允许一个 webai_draw 在跑，进行中再调会被直接拒绝——一轮只调一次，等结果返回后再决定下一步。⚠ 失败重试礼仪：超时/通道错误/needLogin 之后重调时传 reuse=true——优先收取当前页已生成的图，不重复发提示词（豆包侧任务可能仍在进行或已完成）。返回 ok/path/imageUrl/error/needLogin：needLogin=需人工登录（已自动提示用户，登录后重调本工具）；error=结构化失败（如实告知用户，imageUrl 存在时可给用户手动保存）。需桌面端内置浏览器。',
    inputSchema: z.object({
      character: z.string().min(1).max(30).describe('人物名（必须与 设定/角色/{人物名}.md 一致，头像将配置到该人物）'),
      prompt: z.string().min(1).max(8_000).describe('生图提示词（按所用头像技能规范生成的英文主提示词；豆包直接发即可触发生图）'),
      maxWaitMs: z.number().int().min(30_000).max(600_000).optional().describe(`等待图片生成的超时毫秒（默认 ${DEFAULT_MAX_WAIT_MS}，即 240s）`),
      reuse: z.boolean().optional().describe('true=优先收取当前豆包页已生成的图（超时/失败/登录后重调场景，不重发提示词、不重新导航，保留现场直收）；缺省/false=完整流程（导航+基线+发提示词新生成）。当前页无生成图时自动回退完整流程'),
    }),
    execute: async ({ character, prompt, maxWaitMs, reuse }): Promise<WebAiDrawResult> => {
      const name = character.trim()
      if (badName(name)) return { ok: false, error: `人物名不合法：${character}` }

      if (!b.isEmbedded) {
        return { ok: false, error: '网页 AI 生图需要桌面端内置浏览器（当前为纯 Web 模式）。请在桌面应用中使用本功能。' }
      }

      // 互斥锁：同一时间只允许一个 webai_draw（2026-09-02 实测：模型一轮双调，两个驱动
      // 交替 open/eval 同一页面互踩，把浏览器 daemon 楔死→后续所有命令超时→双双空转到超时）
      if (drawInFlight) {
        return { ok: false, error: '已有一个生图任务正在进行中——等它完成后再调（webai_draw 全程互斥，禁止并行）。' }
      }
      drawInFlight = true

      ctx.events.emit({ type: 'browser:agent-control', active: true })
      try {
        const d = await b.detect()
        if (d.cdpStatus !== 'ready') return { ok: false, error: `内置浏览器未就绪：${d.raw.slice(0, 200)}` }
        const lock = await b.lockEmbeddedTab()
        if (!lock.ok) return { ok: false, error: `内置浏览器未就绪：${lock.error}` }

        // reuse 模式（超时/失败/登录后重调）：不导航保留现场，探测当前页是否有可收的生成图。
        // 有图（无论是否仍在生成）→ 跳过导航/基线/发送，直接进入轮询收图流程；
        // 无图（页面已离开豆包或上次任务未产出）→ 自动回退完整流程。
        let skipSend = false
        if (reuse === true) {
          try {
            const href = String((await ev('location.href')) ?? '')
            if (href.includes('doubao.com/chat')) {
              const first = (await ev(DOUBAO.pollNewJs)) as { imgs?: unknown[]; busy?: boolean } | undefined
              if (first && Array.isArray(first.imgs) && first.imgs.length > 0) skipSend = true
            }
          } catch {
            /* 探测失败按无图处理 → 回退完整流程 */
          }
        }

        if (!skipSend) {
          const opened = await b.ab(['open', DOUBAO.homeUrl])
          if (!opened.ok) return { ok: false, error: `打开 ${DOUBAO.homeUrl} 失败：${(opened.stderr || opened.stdout).slice(0, 300)}` }
          await sleep(4_000)
        }

        // 登录判定：15s 加载窗口，仍 false 走人工接管
        let logged = false
        for (const t0 = Date.now(); Date.now() - t0 < 15_000 && !logged; ) {
          logged = await isLoggedIn()
          if (!logged) await sleep(2_000)
        }
        if (!logged) {
          const r = await waitForManualLogin(LOGIN_WAIT_MS)
          if (!r.ok) return { ok: false, needLogin: true, error: r.error }
        }

        // 发送前基线快照：写入页面 window.__avatarBase（归一化 URL 数组）——
        // 之后只认「新增」图片；基线经 window 传递，避免工具层↔页面传参的双层 JSON 解析坑。
        // reuse 模式跳过基线：页面已有的 rc_gen_image 生成图正是要收的目标（靠强特征+静态路径排除兜底）
        if (!skipSend) {
          try {
            await ev(DOUBAO.baselineJs)
          } catch {
            /* 基线失败不阻塞：pollNewJs 读不到 __avatarBase 时按空基线（靠 rc_gen_image 强特征兜底） */
          }
        }

        // 填入并发送（失败重试 1 次）；reuse 收图模式跳过
        if (!skipSend) {
          let sendErr = await fillAndSend(prompt)
          if (sendErr) {
            await sleep(2_000)
            sendErr = await fillAndSend(prompt)
          }
          if (sendErr) return { ok: false, error: `提示词发送失败：${sendErr.slice(0, 300)}` }
        }

        // 轮询图片生成（单 eval 拿全状态：新图探测 + 生成态），完成需同时满足：
        //   ① 基线之外出现已加载完成的大图（≥300px，生成图通常 ≥512）
        //   ② 生成态结束（页面无「正在生成」文案/停止按钮——豆包生成中仍可输入，输入框不可作信号）
        //   ③ 归一化新图集合（去 query 签名）连续 2 轮稳定——签名 URL 每次重渲染都换新，
        //      按完整 URL 比较永不稳定（三测卡死根因）；归一化后 key 恒定
        const waitMs = maxWaitMs ?? DEFAULT_MAX_WAIT_MS
        const deadline = Date.now() + waitMs
        let candidates: Array<{ src: string; key: string; w: number; nw: number; nh: number }> = []
        let stableSig = ''
        let stableCount = 0
        let pollFails = 0
        for (;;) {
          if (ctx.signalRef.current?.aborted) return { ok: false, error: '已被用户停止，生图任务中断' }
          if (Date.now() >= deadline) {
            const partial = candidates.length > 0 ? candidates[candidates.length - 1]!.src : ''
            return {
              ok: false,
              error: `等待图片生成超时（${Math.round(waitMs / 1000)}s）。${partial ? '已探测到候选图片（可能仍在陆续生成）。' : '豆包可能仍在排队或改版（轮询选择器需重新踩点）。'}稍后可用同一提示词传 reuse:true 重调本工具继续收取（豆包侧任务不受影响）。`,
              ...(partial ? { imageUrl: partial } : {}),
            }
          }
          ctx.events.emit({ type: 'browser:agent-control', active: true }) // 长任务脉冲
          let busy = false
          try {
            const r = await ev(DOUBAO.pollNewJs) as { imgs?: typeof candidates; busy?: boolean } | undefined
            if (r && Array.isArray(r.imgs)) {
              candidates = r.imgs
              busy = r.busy === true
              pollFails = 0
            } else {
              pollFails++
            }
          } catch {
            pollFails++
          }
          // 连续读取失败快速失败（四测曾把序列化 bug 的每轮抛错误判成 daemon 死而中断正常生成）：
          // 生图期页面高频重渲染会偶发超时，阈值放宽到 8 轮；文案保持「可重试」语义——
          // 豆包侧任务仍在进行，Agent 稍后用同一提示词重调即可续上（图片仍在会话里）。
          if (pollFails >= 8) {
            return {
              ok: false,
              error: '连续读取豆包页面状态失败（页面繁忙或通道无响应）。豆包侧生成可能仍在进行——稍等片刻后用同一提示词重调本工具即可继续（不必重启）；若持续失败再重启应用。',
            }
          }
          if (pollFails > 0) {
            await sleep(POLL_INTERVAL_MS)
            continue
          }
          const sig = JSON.stringify(candidates.map((c) => c.key).sort())
          stableCount = candidates.length > 0 && !busy ? (sig === stableSig ? stableCount + 1 : 0) : 0
          stableSig = sig
          if (stableCount >= 2) break
          await sleep(POLL_INTERVAL_MS)
        }

        // 多候选取分辨率最高者作头像（豆包一次生成多张）
        const best = candidates.reduce((a, c) => (c.w > a.w ? c : a))
        const imageUrl = best.src

        // 下载：页面上下文 fetch → base64（失败回退 canvas）
        let dataUrl: string | null = null
        let dlErr = ''
        try {
          const r = await ev(`(${DOUBAO.downloadJs})(${JSON.stringify(imageUrl)})`)
          if (typeof r === 'object' && r !== null && 'ok' in r) {
            const o = r as { ok: boolean; dataUrl?: string; error?: string }
            if (o.ok && o.dataUrl) dataUrl = o.dataUrl
            else dlErr = o.error ?? '未知下载错误'
          } else {
            dlErr = `下载脚本返回异常：${JSON.stringify(r).slice(0, 200)}`
          }
        } catch (e) {
          dlErr = e instanceof Error ? e.message : String(e)
        }

        // 写头像文件（旧格式清理 + chokidar 自动广播 file:changed → 前端关系网刷新）
        if (dataUrl) {
          try {
            const saved = saveAvatar(name, dataUrl)
            return { ok: true, site: DOUBAO.id, character: name, path: saved.path, bytes: saved.bytes, imageUrl }
          } catch (e) {
            return { ok: false, imageUrl, error: `头像落盘失败：${e instanceof Error ? e.message : String(e)}` }
          }
        }

        // 页面内下载失败（豆包图床实测封锁 CORS/403/taint/顶层导航防盗链）→ CDP 元素截图兜底：
        // 主路径=直接截元素显示区域（完整保底），升级路径=克隆·视口内最大化（更清晰，校验通过才用）
        const shot = await shotAvatar(name, imageUrl)
        if (shot.ok) {
          return { ok: true, site: DOUBAO.id, character: name, path: shot.path, bytes: shot.bytes, imageUrl }
        }
        return {
          ok: false,
          imageUrl,
          error: `图片已生成但获取失败：页面下载被图床拦截（${dlErr.slice(0, 120)}）；元素截图兜底也未成功（${shot.error ?? ''}）。可把 imageUrl 交给用户手动保存。`,
        }
      } catch (e) {
        return { ok: false, error: `webai_draw 执行异常：${e instanceof Error ? e.message : String(e)}` }
      } finally {
        drawInFlight = false
        ctx.events.emit({ type: 'browser:agent-control', active: false })
      }
    },
  })
}
