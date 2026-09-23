#!/usr/bin/env node
/**
 * split-source.js —— 同人模式拆书边界识别（确定性，供 Bash 白名单执行）
 *
 * 用法：node scripts/split-source.js --input 原著/原文/第一卷.txt --volume 1 [--force]
 *
 * 功能：识别章节边界，只产出 边界.json（每章行号表）——**不落章节文件**：
 * 原文已在 原著/原文/，agent 拆书时直接按 startLine/endLine 用 Read 工具读原文对应区间，
 * 无需把章节一个个复制进工作区。
 * 1. 章节边界识别：第X章/第X回（阿拉伯+中文数字，含千/两/零/〇）、序章、楔子；番外跳过（仅计数）
 * 2. 目录块剔除：文件头部「连续命中且行距极小 + 与后文章号重叠」的段丢弃（重号交集法，防误杀正文首章）
 * 3. 卷内重号检测：同一章号出现两次 → 报错退出（exit 1），让 agent/用户裁定
 * 4. 产出：
 *    原著/拆书/第{V}卷/边界.json   （[{no, title, startLine, endLine, chars}]，行号 1 起含）
 *    stdout 汇总（章数/总字数/跳过番外数）
 * 幂等：边界.json 已存在 → exit 1（重跑请先删该文件与摘要等聚合产物）；
 *       --force：仅覆盖重写 边界.json（升级旧版无行号格式/迁移用，不动摘要）。
 * 兼容：旧版本产生的 章节/ 切片目录不再使用，检测到时提示可删除。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') out.input = argv[++i]
    else if (a === '--volume') out.volume = Number(argv[++i])
    else if (a === '--force') out.force = true
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  return out
}

/* ---------- 中文数字 → 阿拉伯 ---------- */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }

function cnToNum(s) {
  // 纯阿拉伯数字
  if (/^\d+$/.test(s)) return Number(s)
  // 中文数字（支持到 9999：X千X百X十X）
  let total = 0
  let section = 0 // 当前段（千百十位内）
  let digit = null
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]
      if (digit === null) digit = 1 // 「十」「一百二」里的省略一
      section += digit * unit
      digit = null
      if (unit === 1000) {
        total += section
        section = 0
      }
    } else {
      return null
    }
  }
  return total + section + (digit ?? 0)
}

/* ---------- 章节标题识别 ---------- */

// 标题行：第X章/第X回（数字混合中文数字）；序章/楔子/前言/引子 → 章 0；番外 → 跳过
const RE_CHAPTER = /^\s*(?:第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*[章回]\s*(.{0,40})|(序章|楔子|前言|引子)\s*(.{0,40})|(番外)(.{0,40}))\s*$/
const RE_PLAIN_CHAPTER = /^\s*第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章回]/ // 快速预筛

function parseTitleLine(line) {
  if (!RE_PLAIN_CHAPTER.test(line)) {
    // 序章/楔子/番外类
    if (/^\s*(序章|楔子|前言|引子)/.test(line)) return { kind: 'chapter', no: 0, title: line.trim().replace(/\s+/g, ' ') }
    if (/^\s*番外/.test(line)) return { kind: 'extra', no: null, title: line.trim() }
    return null
  }
  const m = RE_CHAPTER.exec(line)
  if (!m) return null
  const no = cnToNum(m[1])
  if (no === null || no < 0 || no > 99999) return null
  const title = (m[2] ?? '').trim().replace(/^[\s：:、.\-—]+/, '').replace(/\s+/g, ' ')
  return { kind: 'chapter', no, title }
}

/* ---------- 主流程 ---------- */

function main() {
  const { input, volume, force } = parseArgs(process.argv)
  if (!input || !Number.isInteger(volume) || volume < 1 || volume > 99) {
    console.error('用法：node scripts/split-source.js --input 原著/原文/第一卷.txt --volume 1 [--force]（volume 为 1-99 整数）')
    process.exit(2)
  }

  let raw
  try {
    raw = fs.readFileSync(input, 'utf8')
  } catch (err) {
    console.error(`读取原文失败：${err.message}（路径：${input}）`)
    process.exit(1)
  }
  // 容 BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  const lines = raw.split(/\r?\n/)
  const outDir = path.join('原著', '拆书', `第${volume}卷`)
  const boundaryFile = path.join(outDir, '边界.json')

  // 幂等保护：边界.json 已存在 → 拒绝重跑（--force 时仅覆盖重写，摘要等不动）
  if (fs.existsSync(boundaryFile)) {
    if (!force) {
      console.error(`已存在 ${boundaryFile}。如需重跑请先删除该文件与 摘要/ 等聚合产物；仅升级旧格式可加 --force。`)
      process.exit(1)
    }
    console.log('--force：将覆盖重写 边界.json（章节行号重新识别；摘要/时间线等产物不动）')
  }

  /* 扫描全部标题行 */
  const hits = [] // { lineIdx, kind, no, title }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length > 60) continue // 标题行不会太长；跳过空行加速
    const t = parseTitleLine(line)
    if (t) hits.push({ lineIdx: i, ...t })
  }
  if (hits.length === 0) {
    console.error('未识别到任何章节标题（第X章/第X回/序章/楔子）。请确认文件是小说原文。')
    process.exit(1)
  }

  /* 目录块剔除（重号交集法）：
     开头密集段 S = 从第一个命中起、相邻行距 ≤2 的最长连续段（仅前 800 行内检测）。
     S 与后续命中 R 的章号交集 ≥3 → S 是文件头目录块：剔除 S 中「章号在 R 或 S 内更晚位置重复」的成员
     （即每个章号只保留最后一次出现——正文首章即使被行距误吸入 S 也能存活）。 */
  const contentHits = []
  let dropCount = 0
  {
    const headerZone = hits.filter((h) => h.lineIdx < 800)
    const restZone = hits.filter((h) => h.lineIdx >= 800)
    // 开头密集段
    let segEnd = 0
    while (segEnd + 1 < headerZone.length && headerZone[segEnd + 1].lineIdx - headerZone[segEnd].lineIdx <= 2) segEnd++
    const seg = headerZone.slice(0, segEnd + 1)
    const rest = [...headerZone.slice(segEnd + 1), ...restZone]

    const num = (h) => (h.kind === 'chapter' ? h.no : null)
    const segNums = new Set(seg.map(num).filter((n) => n !== null))
    const restNums = new Set(rest.map(num).filter((n) => n !== null))
    let overlap = 0
    for (const n of segNums) if (restNums.has(n)) overlap++

    if (seg.length >= 4 && overlap >= 3) {
      // 目录场景：S 内成员保留条件 = 其章号既不在 R、也不在 S 内更晚处出现
      const seenLater = new Set() // 从后往前扫，记录每个章号是否在「更晚位置」出现过
      const keep = new Array(seg.length).fill(true)
      for (let i = seg.length - 1; i >= 0; i--) {
        const n = num(seg[i])
        if (n === null) continue
        if (restNums.has(n) || seenLater.has(n)) {
          keep[i] = false
          dropCount++
        } else {
          seenLater.add(n)
        }
      }
      for (let i = 0; i < seg.length; i++) if (keep[i]) contentHits.push(seg[i])
    } else {
      contentHits.push(...seg)
    }
    contentHits.push(...rest)
  }

  /* 过滤番外 */
  const chapters = contentHits.filter((h) => h.kind === 'chapter')
  const extraCount = contentHits.filter((h) => h.kind === 'extra').length

  /* 重号检测 */
  const seen = new Map()
  for (const c of chapters) {
    if (seen.has(c.no)) {
      console.error(`卷内重号：第 ${c.no} 章出现两次（行 ${seen.get(c.no) + 1} 与 行 ${c.lineIdx + 1}）。原文可能含多卷或分卷重起，请按卷拆分文件后分次上传。`)
      process.exit(1)
    }
    seen.set(c.no, c.lineIdx)
  }

  /* 行号表写出：每章 {no, title, startLine, endLine, chars}（行号 1 起含；endLine=下一章标题行-1，末章=总行数） */
  fs.mkdirSync(outDir, { recursive: true })
  const boundary = []
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    const startLine = c.lineIdx + 1
    const endLine = i + 1 < chapters.length ? chapters[i + 1].lineIdx : lines.length
    const body = lines.slice(c.lineIdx + 1, endLine).join('\n')
    boundary.push({ no: c.no, title: c.title, startLine, endLine, chars: body.length })
  }

  fs.writeFileSync(boundaryFile, JSON.stringify(boundary, null, 2), 'utf8')

  const totalChars = boundary.reduce((acc, b) => acc + b.chars, 0)
  console.log(`边界识别完成：第 ${volume} 卷共 ${boundary.length} 章（${Math.round(totalChars / 10000)} 万字），原文 ${lines.length} 行`)
  if (dropCount > 0) console.log(`已剔除文件头目录块 ${dropCount} 行标题`)
  if (extraCount > 0) console.log(`跳过番外 ${extraCount} 个（同人多按正章时间线，如需请单独处理）`)
  // 旧版本兼容提示：章节切片不再使用
  const legacyChapterDir = path.join(outDir, '章节')
  if (fs.existsSync(legacyChapterDir)) {
    console.log(`检测到旧版章节切片目录 ${legacyChapterDir}（已不再使用，可直接删除）。`)
  }
  console.log(`产物：${boundaryFile}（每章 startLine/endLine 行号，agent 用 Read offset/limit 直读原文，不落章节文件）`)
  console.log('下一步：回填 _progress.json 本卷 chapters 并按事件桥段摘要（见 step3-deconstruct.md）')
}

main()
