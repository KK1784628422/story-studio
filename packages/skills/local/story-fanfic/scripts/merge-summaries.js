#!/usr/bin/env node
/**
 * merge-summaries.js —— 同人拆书摘要归并（确定性脚本，供 Bash 白名单执行）
 *
 * 用法：
 *   检测：node scripts/merge-summaries.js --volume 1 --check
 *   归并：node scripts/merge-summaries.js --volume 1 --segments "1-8:事件一,9-40:事件二,41-89:事件三"
 *
 * 背景：历史会话可能产出「一章一个摘要文件」（如 001章_章节标题.md）的旧粒度；agent 看到这些
 * 文件会模仿旧格式继续逐章写（prompt 约束敌不过目录里的既有模式）。本脚本把归并变成确定性操作：
 *
 * ① --check：扫描 摘要/ 目录，发现单章粒度文件（文件名只有一个章号、非区间命名）→ 列出并 exit 1；
 *    无单章文件 → exit 0（全部是区间粒度）。
 * ② --segments：按显式计划归并——每段 "起-止:名称"（逗号分隔）。对每段：
 *    - 收集落在该区间内的**单章摘要文件**（按章号升序）；
 *    - 各文件正文降级为 `## 第NNN章 标题` 小节，拼接为 `# 第NNN-MMM章 摘要（名称）` 的区间文件；
 *    - 删除已并入的单章文件（归并完一段删一段）；
 *    - 区间内没有单章文件的段跳过（未拆解的留待 agent 按段直接写区间文件）。
 * 幂等：重跑安全——单章文件已删则各段自然跳过；已存在的区间文件不会被覆盖（跳过并提示）。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const out = { volume: null, check: false, segments: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--volume') out.volume = Number(argv[++i])
    else if (a === '--check') out.check = true
    else if (a === '--segments') out.segments = argv[++i]
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  return out
}

/* ---------- 文件名解析：单章 or 区间 ---------- */

/** 区间命名：第NNN-MMM章 / 第NNN章-第MMM章 / NNN~MMM章（文件名含两个章号且以 -/~/—/至 相连） */
const RE_RANGE = /^第?(\d{1,5})\s*[-~—至]\s*第?(\d{1,5})章/
/** 单章命名：第NNN章_标题 / NNN章_标题（只有一个章号） */
const RE_SINGLE = /^第?(\d{1,5})章/

/** 分类摘要文件：{ single: Map<章号,文件名>, range: [{start,end,file}] } */
function classify(dir) {
  const single = new Map()
  const range = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const mRange = RE_RANGE.exec(name)
    if (mRange) {
      range.push({ start: Number(mRange[1]), end: Number(mRange[2]), file: name })
      continue
    }
    const mSingle = RE_SINGLE.exec(name)
    if (mSingle) single.set(Number(mSingle[1]), name)
    // 既非区间也非单章命名的文件不动（人工文件）
  }
  return { single, range }
}

/* ---------- 主流程 ---------- */

function main() {
  const { volume, check, segments } = parseArgs(process.argv)
  if (!Number.isInteger(volume) || volume < 1 || volume > 99) {
    console.error('用法：node scripts/merge-summaries.js --volume 1 [--check | --segments "1-10:穿越,11-40:觉醒"]')
    process.exit(2)
  }

  const dir = path.join('原著', '拆书', `第${volume}卷`, '摘要')
  if (!fs.existsSync(dir)) {
    console.log(`摘要目录不存在（${dir}）——本卷尚未开始拆书，无需归并。`)
    return
  }

  const { single, range } = classify(dir)

  if (check) {
    if (single.size === 0) {
      console.log(`检查通过：${range.length} 个摘要文件均为区间（桥段）粒度，无单章文件。`)
      return
    }
    console.error(`发现 ${single.size} 个单章粒度旧摘要（禁止逐章粒度，必须先归并）：`)
    const nums = [...single.keys()].sort((a, b) => a - b)
    for (const n of nums) console.error(`  - ${single.get(n)}`)
    console.error('归并命令：node scripts/merge-summaries.js --volume ' + volume + ' --segments "起-止:事件名,起-止:事件名"（分段按 原著/原著信息.md 分段表的事件展开，章节定位参考 边界.json 标题）')
    process.exit(1)
  }

  if (!segments) {
    console.error('缺少 --segments 计划（或用 --check 仅检测）。格式："1-8:事件一,9-40:事件二"')
    process.exit(2)
  }

  // 解析计划：[{start,end,name}]
  const plan = []
  for (const part of segments.split(/[,，]/)) {
    const m = /^(\d{1,5})\s*[-~—至]\s*(\d{1,5})\s*[:：]\s*(.+)$/.exec(part.trim())
    if (!m) {
      console.error(`分段格式错误：「${part}」（应为 起-止:名称）`)
      process.exit(2)
    }
    plan.push({ start: Number(m[1]), end: Number(m[2]), name: m[3].trim().slice(0, 40) })
  }
  // 计划合法性：区间不重叠、升序
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].start <= plan[i - 1].end) {
      console.error(`分段区间重叠或乱序：「${plan[i - 1].start}-${plan[i - 1].end}」与「${plan[i].start}-${plan[i].end}」`)
      process.exit(2)
    }
  }

  const pad = (n) => String(n).padStart(3, '0')
  let mergedCount = 0
  let skipped = 0

  for (const seg of plan) {
    // 该区间内的单章文件（升序）
    const inRange = [...single.entries()].filter(([n]) => n >= seg.start && n <= seg.end).sort((a, b) => a[0] - b[0])
    if (inRange.length === 0) {
      console.log(`段 ${pad(seg.start)}-${pad(seg.end)}「${seg.name}」：区间内无单章文件，跳过`)
      skipped++
      continue
    }
    const target = `${pad(seg.start)}-${pad(seg.end)}章.md`
    const targetAbs = path.join(dir, target)
    if (fs.existsSync(targetAbs)) {
      console.log(`段 ${pad(seg.start)}-${pad(seg.end)}「${seg.name}」：目标文件已存在（${target}），跳过防覆盖`)
      skipped++
      continue
    }

    // 拼接：各单章文件正文降级为 ## 小节（原 H1 转小节标题，其余原样保留）
    const parts = [`# 第${seg.start}-${seg.end}章 摘要（${seg.name}）`, '']
    parts.push(`- 覆盖章节：第${seg.start}章 - 第${seg.end}章`)
    parts.push(`- 所属段落：（见 原著/原著信息.md 分段表）`)
    parts.push(`- 段落概要：${seg.name}`)
    parts.push(`- 说明：本文件由 ${inRange.length} 个单章摘要脚本归并；后续会话按桥段模板补全细化（故事时间/地点/角色变化等）。`)
    parts.push('')
    for (const [n, file] of inRange) {
      let body = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\s+$/, '')
      // 原 H1（# 第N章 标题 / # 第N章 标题 摘要）→ ## 小节
      body = body.replace(/^#\s+(.+)$/m, '## $1')
      parts.push(body)
      parts.push('')
    }
    fs.writeFileSync(targetAbs, parts.join('\n') + '\n', 'utf8')
    // 归并完一段删一段
    for (const [, file] of inRange) fs.unlinkSync(path.join(dir, file))
    for (const [n] of inRange) single.delete(n)
    mergedCount++
    console.log(`段 ${pad(seg.start)}-${pad(seg.end)}「${seg.name}」：归并 ${inRange.length} 个单章 → ${target}（原文件已删）`)
  }

  // 收尾报告
  const rest = [...single.keys()].sort((a, b) => a - b)
  console.log(`归并完成：${mergedCount} 段合并、${skipped} 段跳过。`)
  if (rest.length > 0) {
    console.error(`⚠ 仍有 ${rest.length} 个单章文件不在任何计划段内（章号：${rest.slice(0, 20).join(', ')}${rest.length > 20 ? '…' : ''}）——计划段未覆盖，请补充分段后重跑。`)
    process.exit(1)
  }
  console.log('下一步：未拆解章节按第 3 节事件桥段直接写区间文件；写前可跑 --check 自查。')
}

main()
