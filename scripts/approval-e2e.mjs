/**
 * 审批闭环 E2E：讨论模式让 Agent 写文件 → 流停在审批请求 → 模拟用户批准（第二轮带 approval-response）
 * → 验证工具执行 + 文件落盘。用法：node scripts/approval-e2e.mjs
 */
const BASE = process.env.LIVE_BASE ?? 'http://127.0.0.1:8100'
const sessionId = `apv${Date.now().toString(36).slice(-5)}`
const TARGET = '设定/测试卡片.md'
const instruction = `请在 ${TARGET} 下新建文件，内容就一行：# 测试卡片。写完即可，不要做别的。`

const post = async (messages) => {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, messages, mode: 'discuss' }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.body
}

const consume = async (stream, onChunk) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
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
        onChunk(JSON.parse(line.slice(5)))
      } catch {
        // 非 JSON
      }
    }
  }
}

console.log(`[apv] session=${sessionId} round1：发起写文件请求（讨论模式，Write 需审批）`)
let approvalId = null
let sawWriteOutput = false
let writeError = null

const userMsg = { id: 'u1', role: 'user', parts: [{ type: 'text', text: instruction }] }

await consume(await post([userMsg]), (c) => {
  if (c.type === 'tool-approval-request') {
    approvalId = c.approvalId ?? c.approval?.id ?? null
    console.log(`  [r1] ⏸ 审批请求 id=${approvalId} tool=${c.toolCall?.toolName ?? JSON.stringify(c.toolCall).slice(0, 80)}`)
  }
})
if (!approvalId) {
  console.log('✗ 第一轮未出现审批请求')
  process.exit(1)
}

// 从会话持久化中取回 assistant 消息（含 approval-requested tool part）
const sess = await (await fetch(`${BASE}/api/sessions/${sessionId}`)).json()
const assistantMsg = sess.messages.findLast((m) => m.role === 'assistant')
if (!assistantMsg) {
  console.log('✗ 会话中未找到 assistant 消息（onFinish 未持久化？）')
  process.exit(1)
}
console.log(`  [r1] assistant 消息已持久化（${assistantMsg.parts.length} parts）`)

// 把 approval-requested part 改写为 approval-responded（用户批准；SDK 契约：state='approval-responded'）
const approvedMsg = {
  ...assistantMsg,
  parts: assistantMsg.parts.map((p) =>
    p.state === 'approval-requested'
      ? { ...p, state: 'approval-responded', approval: { ...p.approval, approved: true } }
      : p,
  ),
}

console.log('[apv] round2：以批准响应续流')
await consume(await post([userMsg, approvedMsg]), (c) => {
  if (c.type === 'tool-input-available') console.log(`  [r2] 🔧 ${c.toolName} ${JSON.stringify(c.input ?? {}).slice(0, 80)}`)
  if (c.type === 'tool-output-available') {
    const out = JSON.stringify(c.output ?? {})
    if (out.includes(TARGET)) {
      sawWriteOutput = !out.includes('"error"')
      writeError = (c.output ?? {}).error ?? null
    }
  }
  if (c.type === 'finish') console.log(`  [r2] finish（${c.finishReason}）`)
})

// 核验落盘
const doc = await fetch(`${BASE}/api/doc?path=${encodeURIComponent(TARGET)}`)
const written = doc.ok ? (await doc.json()).markdown.trim() : null
console.log(`\n[apv] 结果：`)
console.log(`  审批请求：✓（id=${approvalId}）`)
console.log(`  批准后 Write 执行：${sawWriteOutput ? '✓' : `✗ ${writeError ?? '未见输出'}`}`)
console.log(`  文件落盘：${written === '# 测试卡片' ? `✓（${TARGET} = "${written}"）` : `✗（${doc.status} "${written ?? ''}"）`}`)
const pass = approvalId && sawWriteOutput && written === '# 测试卡片'
console.log(pass ? '✓ 审批闭环 E2E 通过' : '✗ 审批闭环失败')
process.exit(pass ? 0 : 1)
