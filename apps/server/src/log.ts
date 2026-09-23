/**
 * 聊天日志：统一入口 → ①服务端 stdout ②logs/chat.log 文件 ③WS 推前端日志抽屉。
 * 用于排查「审批后 Agent 不继续 / 任务中途停住」等流式问题。
 *
 * 【2026-09-01 教训：日志系统自激死循环】stdout 管道断裂（EPIPE，electron 父进程
 * 重启/退出后遗留的 server 孤儿进程常见）时 console.log 抛错 → uncaughtException
 * 处理器调 chatLog 记录 → 又 console.log → 再 EPIPE …… 无限自循环（实测写爆 3GB /
 * 384 万行）。三重防御：
 *   ① console 输出包 try/catch，EPIPE 后置 stdoutDead 标记不再尝试 console（文件/WS 照常）；
 *   ② 配合 index.ts 的 uncaughtException 防重入（chatLog 绝不抛错是根本）；
 *   ③ 按大小轮转（单份 10MB × 3 备份），启动时超 20MB 截断保留尾部 2MB。
 */
import { appendFileSync, mkdirSync, statSync, openSync, readSync, writeSync, renameSync, unlinkSync, existsSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { EventHub } from './ws.ts'

export type LogLevel = 'info' | 'warn' | 'error'

/** 本地时间戳（含时区偏移，如 2026-08-27T16:10:00.123+08:00）；toISOString 是 UTC，国内用户看着差 8 小时 */
export function localTimestamp(d = new Date()): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

let logFile = ''
let hub: EventHub | null = null
/** stdout 管道已断（EPIPE 后置 true，不再尝试 console——文件/WS 输出不受影响） */
let stdoutDead = false
/** 上次轮转检查时刻：写入热路径上 60s 检查一次大小，避免每条日志 statSync */
let lastRotateCheck = 0

/** 单份日志上限（超出轮转）；备份保留 3 份 → 日志目录最多约 40MB */
const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_BACKUPS = 3
/** 启动截断阈值与保留尾部：现有超大文件（如死循环写出的 3GB）只留尾部 */
const STARTUP_TRIM_BYTES = 20 * 1024 * 1024
const TAIL_KEEP_BYTES = 2 * 1024 * 1024

/** 启动时截断超大日志：保留尾部 TAIL_KEEP_BYTES（近期排查线索）+ 一行截断说明 */
function trimOversizedAtStartup(): void {
  let size = 0
  try {
    size = statSync(logFile).size
  } catch {
    return // 文件不存在
  }
  if (size <= STARTUP_TRIM_BYTES) return
  try {
    const keep = Math.min(TAIL_KEEP_BYTES, size)
    const fd = openSync(logFile, 'r')
    const buf = Buffer.alloc(keep)
    readSync(fd, buf, 0, keep, size - keep)
    closeQuiet(fd)
    const fdw = openSync(logFile, 'w')
    writeSync(fdw, `[${localTimestamp()}] [WARN] [log] 日志超限截断：原 ${size} 字节，保留尾部 ${keep} 字节（完整历史已丢弃）\n`)
    writeSync(fdw, buf)
    closeQuiet(fdw)
  } catch {
    /* 截断失败：保留原文件继续追加（轮转仍会在写入路径生效） */
  }
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    /* 已关闭 */
  }
}

/** 按大小轮转：chat.log → .1 → .2 → .3（删最老）。rename 失败（Windows 句柄占用）忽略，下次再试 */
function rotateIfNeeded(): void {
  let size = 0
  try {
    size = statSync(logFile).size
  } catch {
    return
  }
  if (size <= MAX_LOG_BYTES) return
  try {
    // 从老到新依次让位（.2→.3 删除、.1→.2、当前→.1）
    const oldest = `${logFile}.${MAX_BACKUPS}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${logFile}.${i}`
      if (existsSync(from)) renameSync(from, `${logFile}.${i + 1}`)
    }
    renameSync(logFile, `${logFile}.1`)
  } catch {
    /* 轮转失败不影响写入 */
  }
}

/** 启动时初始化：日志文件位置 + WS 推送通道（顺带截断历史超大文件） */
export function initLogger(rootDir: string, h: EventHub): void {
  const dir = join(rootDir, 'logs')
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'chat.log')
  hub = h
  trimOversizedAtStartup()
}

export function chatLog(level: LogLevel, msg: string): void {
  const line = `[${localTimestamp()}] [${level.toUpperCase()}] ${msg}`
  // stdout 输出：包 try/catch——EPIPE（父进程管道断）绝不能让 chatLog 抛错，
  // 否则与 uncaughtException 处理器形成自激死循环（历史事故：3GB / 384 万行）
  if (!stdoutDead) {
    try {
      console.log(line)
    } catch {
      stdoutDead = true // 管道已死：后续只走文件 + WS，不再碰 console
    }
  }
  if (logFile) {
    try {
      // 大小检查节流（60s 一次）：热路径上不每条 stat
      const now = Date.now()
      if (now - lastRotateCheck > 60_000) {
        lastRotateCheck = now
        rotateIfNeeded()
      }
      appendFileSync(logFile, `${line}\n`, 'utf8')
    } catch {
      // 日志写入失败不阻塞主流程
    }
  }
  try {
    hub?.log(level, msg)
  } catch {
    // WS 广播失败不反噬日志调用方
  }
}
