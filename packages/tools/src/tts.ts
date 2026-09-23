/**
 * Edge TTS 客户端（TS 移植自 novel-reader 的 EdgeTtsService.java）：
 * 复刻微软 Edge「大声朗读」WSS 协议，Sec-MS-GEC 签名 + 时钟偏移校正 + mp3 磁盘缓存。
 *
 * 本文件不含任何私有凭据：下方的 TRUSTED_CLIENT_TOKEN 是微软 Edge 浏览器「大声朗读」
 * 扩展内置的**公开固定值**（Chromium 扩展 id 同为此值），edge-tts 系开源移植普遍使用，
 * 非本项目的账号或密钥。本仓库不附带任何 API key，模型端点与密钥一律由使用者自备。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

/** 微软 Edge 朗读扩展的公开常量（非私钥，见文件头说明） */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_VERSION = '143.0.3650.75'
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const WIN_EPOCH = 11644473600
const TOTAL_TIMEOUT_MS = 30_000

export const TTS_VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural',
] as const

/** 服务端时钟偏移（握手 401/403 时从 Date 头自动校正） */
let clockSkewMillis = 0

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function uuidNoDash(): string {
  return randomUUID().replaceAll('-', '')
}

function httpDate(): string {
  const d = new Date()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
  )
}

/** Sec-MS-GEC：UTC 秒 + Windows 纪元（含偏移校正）→ 取整 5 分钟 → ×10^7 ticks → +token → SHA-256 大写 */
function secMsGec(): string {
  let ticks = Math.floor((Date.now() + clockSkewMillis) / 1000) + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= 10_000_000
  return sha256Hex(`${ticks}${TRUSTED_CLIENT_TOKEN}`).toUpperCase()
}

function toFullVoiceName(shortName: string): string {
  if (shortName.startsWith('Microsoft ')) return shortName
  const split = shortName.lastIndexOf('-')
  if (split <= 0) return shortName
  const locale = shortName.slice(0, split)
  const name = shortName.slice(split + 1)
  return `Microsoft Server Speech Text to Speech Voice (${locale}, ${name})`
}

function speechConfig(): string {
  // 与官方客户端逐字节对齐：无 X-RequestId；句级边界（词级会导致超短中文返回空音频）
  return (
    `X-Timestamp:${httpDate()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{' +
    '"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},' +
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  )
}

function ssmlRequest(requestId: string, voice: string, rate: string, pitch: string, text: string): string {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>` +
    escaped +
    '</prosody></voice></speak>'
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    // 末尾多余 Z 是微软服务端的怪癖，须保留
    `X-Timestamp:${httpDate()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  )
}

export class TtsError extends Error {}

export class EdgeTtsService {
  private cacheDir: string

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir
    mkdirSync(cacheDir, { recursive: true })
  }

  /** 合成语音；相同 voice/rate/pitch/text 命中磁盘缓存直接返回 */
  async synthesize(voice: string | undefined, rate: string | undefined, pitch: string | undefined, text: string): Promise<Buffer> {
    const safeVoice = !voice || !voice.trim() ? 'zh-CN-XiaoxiaoNeural' : voice.trim()
    const safeRate = !rate || !rate.trim() ? '+0%' : rate.trim()
    const safePitch = !pitch || !pitch.trim() ? '+0%' : pitch.trim()
    let clipped = text?.trim() ?? ''
    if (!clipped) throw new TtsError('text 为空')
    if (clipped.length > 600) clipped = clipped.slice(0, 600)

    const key = sha256Hex(`${safeVoice}|${safeRate}|${safePitch}|${clipped}`)
    const cached = join(this.cacheDir, `${key}.mp3`)
    if (existsSync(cached)) {
      const buf = readFileSync(cached)
      if (buf.length > 0) return buf
    }

    const audio = await this.doSynthesize(safeVoice, safeRate, safePitch, clipped)
    const tmp = join(this.cacheDir, `${key}.tmp`)
    writeFileSync(tmp, audio)
    renameSync(tmp, cached)
    return audio
  }

  private async doSynthesize(voice: string, rate: string, pitch: string, text: string): Promise<Buffer> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * attempt + 250 * attempt * attempt))
      }
      try {
        return await this.connectOnce(voice, rate, pitch, text)
      } catch (err) {
        lastError = err
        adjustClockSkew(err)
      }
    }
    throw lastError instanceof Error ? lastError : new TtsError(String(lastError))
  }

  private connectOnce(voiceShort: string, rate: string, pitch: string, text: string): Promise<Buffer> {
    return new Promise<Buffer>((resolveP, rejectP) => {
      const requestId = uuidNoDash()
      const voice = toFullVoiceName(voiceShort)
      const uri =
        `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
        `&ConnectionId=${requestId}` +
        `&Sec-MS-GEC=${secMsGec()}` +
        `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`

      const audioChunks: Buffer[] = []
      let settled = false

      const finish = (err: unknown, buf?: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          // 已关闭
        }
        if (err) rejectP(err)
        else resolveP(buf!)
      }

      const ws = new WebSocket(uri, {
        headers: {
          Origin: ORIGIN,
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Cookie: `muid=${uuidNoDash().slice(0, 32).toUpperCase()};`,
        },
        handshakeTimeout: 10_000,
      })

      const timer = setTimeout(() => {
        finish(new TtsError('TTS 合成超时（30s）'))
        try {
          ws.terminate()
        } catch {
          // ignore
        }
      }, TOTAL_TIMEOUT_MS)

      ws.on('open', () => {
        ws.send(speechConfig())
        ws.send(ssmlRequest(uuidNoDash(), voice, rate, pitch, text))
      })

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // ws 库已重组分片：每条二进制 message 即一完整帧（2 字节头长 + 头 + mp3 数据）
          consumeBinaryFrame(data, audioChunks)
        } else {
          const msg = data.toString('utf8')
          if (msg.includes('Path:turn.end')) {
            const out = Buffer.concat(audioChunks)
            if (out.length === 0) finish(new TtsError('合成结果为空'))
            else finish(null, out)
          }
        }
      })

      ws.on('close', (code, reason) => {
        const out = Buffer.concat(audioChunks)
        if (out.length > 0) finish(null, out)
        else finish(new TtsError(`连接被关闭 status=${code} reason=${reason}`))
      })

      ws.on('unexpected-response', (_req, res) => {
        const err = new TtsError(`TTS 握手失败 HTTP ${res.statusCode}`)
        ;(err as TtsError & { response?: unknown }).response = res
        finish(err)
      })

      ws.on('error', (err) => {
        finish(err)
      })
    })
  }
}

function consumeBinaryFrame(full: Buffer, audioChunks: Buffer[]): void {
  if (full.length >= 2) {
    const headerLen = ((full[0]! & 0xff) << 8) | (full[1]! & 0xff)
    if (full.length > headerLen + 2) {
      audioChunks.push(full.subarray(headerLen + 2))
    }
  }
}

/** 握手 401/403 通常是本机时钟偏差导致签名失效：从响应 Date 头校正偏移 */
function adjustClockSkew(err: unknown): void {
  const res = (err as { response?: { statusCode?: number; headers?: Record<string, string | string[] | undefined> } })
    ?.response
  if (!res?.headers) return
  const code = res.statusCode
  const dateHeader = res.headers['date']
  const date = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader
  if ((code === 401 || code === 403) && date) {
    const serverMs = Date.parse(date)
    if (!Number.isNaN(serverMs)) {
      clockSkewMillis = serverMs - Date.now()
    }
  }
}
