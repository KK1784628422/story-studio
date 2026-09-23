/**
 * M0.6 实写验证：直连 /api/chat 跑「写第10章」全流程（SSE 流式打印工具事件）
 * 用法：node scripts/live-test.mjs ["可选指令"]
 * 前置：server 已以 STORY_STUDIO_WORKSPACE=.local/test-workspace 启动
 */
const BASE = process.env.LIVE_BASE ?? 'http://127.0.0.1:8100'
const instruction = process.argv[2] ?? '写第10章'
const mode = process.argv[3] ?? 'write'
const sessionId = `live${Date.now().toString(36).slice(-5)}`

const TIMEOUT_MS = 25 * 60 * 1000
const ac = new AbortController()
const timer = setTimeout(() => {
  console.log('[live] 超时中止')
  ac.abort()
}, TIMEOUT_MS)

console.log(`[live] session=${sessionId} 指令：「${instruction}」mode=${mode}`)

const message = {
  id: `msg-${Date.now()}`,
  role: 'user',
  parts: [{ type: 'text', text: instruction }],
}

let res
try {
  res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, messages: [message], mode }),
    signal: ac.signal,
  })
} catch (e) {
  console.error('[live] 连接失败（server 未启动？）:', e.message)
  process.exit(1)
}
if (!res.ok) {
  console.error(`[live] HTTP ${res.status}:`, await res.text())
  process.exit(1)
}
console.log(`[live] SSE 已连接（x-session-id: ${res.headers.get('x-session-id')}）`)

const started = Date.now()
let toolCount = 0
let textLen = 0
let approvalRequests = 0
const toolStates = new Map()

const summarize = (name, output) => {
  if (!output || typeof output !== 'object') return String(output ?? '').slice(0, 100)
  if (output.gate) {
    return output.gate.passed
      ? `GATE PASSED（第${output.gate.attempts}次）`
      : `GATE FAILED（第${output.gate.attempts}次${output.gate.stopped ? '，已转人工' : ''}）`
  }
  if (typeof output.exitCode === 'number') return `exit ${output.exitCode}`
  if (name === 'load_skill') return `已加载 ${output.name}`
  if (output.error) return String(output.error).slice(0, 120)
  return JSON.stringify(output).slice(0, 100)
}

const handle = (chunk) => {
  switch (chunk.type) {
    case 'tool-approval-request':
    case 'tool-input-available':
      if (chunk.type === 'tool-approval-request') {
        approvalRequests++
        console.log(
          `  [${elapsed()}s] ⏸ 审批请求：${chunk.toolCall?.toolName ?? '?'} ${JSON.stringify(chunk.toolCall?.input ?? {}).slice(0, 100)}`,
        )
        break
      }
      toolCount++
      toolStates.set(chunk.toolCallId, chunk.toolName)
      console.log(
        `  [${elapsed()}s] 🔧 ${chunk.toolName} ${JSON.stringify(chunk.input ?? {}).slice(0, 140)}`,
      )
      break
    case 'tool-output-available': {
      const name = toolStates.get(chunk.toolCallId) ?? '?'
      console.log(`  [${elapsed()}s]   ↳ ${summarize(name, chunk.output)}`)
      break
    }
    case 'tool-output-error':
      console.log(`  [${elapsed()}s]   ↳ ❌ ${JSON.stringify(chunk.error ?? {}).slice(0, 200)}`)
      break
    case 'text-delta':
      textLen += chunk.delta?.length ?? 0
      break
    case 'error':
      console.log(`  [${elapsed()}s] ❌ STREAM ERROR: ${JSON.stringify(chunk).slice(0, 300)}`)
      break
    case 'finish':
      console.log(`  [${elapsed()}s] ✅ finish (${JSON.stringify(chunk).slice(0, 160)})`)
      break
    default:
      break
  }
}

const elapsed = () => ((Date.now() - started) / 1000).toFixed(1)

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
try {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      try {
        handle(JSON.parse(line.slice(5)))
      } catch {
        // 心跳/非 JSON 行
      }
    }
  }
} catch (e) {
  if (!ac.signal.aborted) console.error('[live] 流读取异常:', e.message)
}

clearTimeout(timer)
console.log(`\n[live] 流结束：${toolCount} 次工具调用，${approvalRequests} 个审批停靠，${textLen} 字文本，耗时 ${elapsed()}s`)
if (mode === 'discuss') {
  console.log(approvalRequests > 0 ? '✓ 讨论模式审批停靠生效（Write/Edit 需用户批准）' : '✗ 未见审批请求（需排查 toolApproval）')
  process.exit(approvalRequests > 0 ? 0 : 1)
}

// 验证结果
console.log('\n== 结果核验 ==')
const book = await (await fetch(`${BASE}/api/book`)).json()
console.log(`  章节数：${book.chapters.length}，最新：第${book.latestChapter}章，追踪：rev ${book.trackingRevision}（已提交至第${book.lastCommittedChapter}章）`)
const ch10 = book.chapters.find((c) => c.index === 10)
if (ch10) {
  const content = await (await fetch(`${BASE}/api/chapter/10`)).json()
  console.log(`  ✓ 第10章已落盘：${ch10.file}（${ch10.bytes} B，标题：${ch10.title}）`)
  console.log(`  正文前 120 字：${content.markdown.replace(/\s+/g, ' ').slice(0, 120)}…`)
} else {
  console.log('  ✗ 第10章未落盘')
}
if (book.trackingRevision === 9 && book.lastCommittedChapter === 9) {
  console.log('  ✓ 追踪事务已提交：state_revision 8 → 9，last_committed_chapter 9')
} else {
  console.log(`  ✗ 追踪状态异常：rev=${book.trackingRevision} committed=${book.lastCommittedChapter}（期望 9/9）`)
}
process.exit(0)
