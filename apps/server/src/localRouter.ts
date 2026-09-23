/**
 * L1 本地意图路由分类器（命中路由实现方案 §3.2）：
 * 字符 1-3 gram TF-IDF + 类质心（Rocchio）余弦分类，纯 Node 实现——
 * 训练与推理同语言、零 Python/二进制依赖，~150 样本训练 <100ms，单次推理 <2ms。
 *
 * 置信语义（启动后按种子集标定）：
 *   s1 = 与最近类质心的余弦；margin = s1 - s2（次近类）
 *   outOfDomain：s1 低于下限（闲聊/无关输入）→ 明确"不路由"，可跳过 LLM 省 token
 *   confident：margin 足够大 → 直接采纳
 *   uncertain：中间带 → 交 L2 复核
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ModeId } from '@story-studio/shared'
import { chatLog } from './log.ts'
import { LOCAL_ROUTER_SEED } from './localRouterSeed.ts'

export interface LocalClassifyResult {
  mode: ModeId
  /** 0~1：s1 与最近质心的余弦相似度 */
  s1: number
  /** s1 - s2：与次近类的间隔，越大越可信 */
  margin: number
  /** 综合置信（已按种子集标定到 0~1） */
  conf: number
  /** 各类相似度（调试/标定用） */
  sims: Record<string, number>
}

const MODES: ModeId[] = ['discuss', 'write', 'import', 'polish', 'preview', 'market', 'review']

/** 清洗：保留中英文/数字，压空白（中文无分词，靠字符 n-gram） */
function clean(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '')
}

/** 字符 1-3 gram + ASCII 词元 */
function features(text: string): string[] {
  const t = clean(text)
  const out: string[] = []
  // ASCII 连续串作为整词特征（章号/英文词）
  for (const m of t.matchAll(/[a-z0-9]+/g)) out.push(`w:${m[0]}`)
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= t.length; i++) out.push(`c${n}:${t.slice(i, i + n)}`)
  }
  return out
}

interface Model {
  /** feature → idf */
  idf: Map<string, number>
  /** mode → 归一化质心向量 */
  centroids: Map<ModeId, Map<string, number>>
  /** 训练样本数（日志用） */
  samples: number
}

function tfVector(text: string, idf: Map<string, number>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of features(text)) counts.set(f, (counts.get(f) ?? 0) + 1)
  const v = new Map<string, number>()
  let norm = 0
  for (const [f, c] of counts) {
    const w = (1 + Math.log(c)) * (idf.get(f) ?? Math.log(1 + 1))
    v.set(f, w)
    norm += w * w
  }
  norm = Math.sqrt(norm) || 1
  for (const [f, w] of v) v.set(f, w / norm)
  return v
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [f, w] of small) {
    const w2 = large.get(f)
    if (w2) dot += w * w2
  }
  return dot
}

export class LocalRouter {
  private model: Model | null = null
  private readonly extraFile: string

  constructor(rootDir: string) {
    // 可选追加样本（Phase 2 挖掘/人工纠偏）：.local/local-router/train.jsonl，每行 {"text","mode"}
    this.extraFile = join(rootDir, '.local', 'local-router', 'train.jsonl')
  }

  /** 启动时训练（种子 + 可选追加样本）。失败不抛出——L1 整体降级跳过 */
  init(): void {
    try {
      const samples: Array<{ text: string; mode: string }> = [...LOCAL_ROUTER_SEED]
      if (existsSync(this.extraFile)) {
        const lines = readFileSync(this.extraFile, 'utf8').split(/\r?\n/).filter(Boolean)
        let extra = 0
        for (const line of lines) {
          try {
            const o = JSON.parse(line) as { text?: string; mode?: string }
            if (o.text && MODES.includes(o.mode as ModeId)) {
              samples.push({ text: o.text, mode: o.mode as string })
              extra++
            }
          } catch {
            /* 坏行忽略 */
          }
        }
        if (extra > 0) chatLog('info', `[local-router] 追加样本 ${extra} 条（train.jsonl）`)
      }

      // 1) DF → IDF
      const df = new Map<string, number>()
      const vecs = samples.map((s) => {
        const fs = new Set(features(s.text))
        for (const f of fs) df.set(f, (df.get(f) ?? 0) + 1)
        return fs
      })
      const N = samples.length
      const idf = new Map<string, number>()
      for (const [f, d] of df) idf.set(f, Math.log((N + 1) / (d + 1)) + 1)

      // 2) 每类质心 = 成员 TF-IDF 向量均值（再归一化）
      const centroids = new Map<ModeId, Map<string, number>>()
      for (const mode of MODES) {
        const acc = new Map<string, number>()
        const members = samples.filter((s) => s.mode === mode)
        for (const s of members) {
          for (const [f, w] of tfVector(s.text, idf)) acc.set(f, (acc.get(f) ?? 0) + w)
        }
        let norm = 0
        for (const w of acc.values()) norm += w * w
        norm = Math.sqrt(norm) || 1
        const c = new Map<string, number>()
        for (const [f, w] of acc) c.set(f, w / norm)
        centroids.set(mode, c)
      }

      this.model = { idf, centroids, samples: N }
      chatLog('info', `[local-router] 已训练：${N} 样本 / ${idf.size} 特征 / 7 类（推理 <2ms）`)
    } catch (err) {
      this.model = null
      chatLog('warn', `[local-router] 训练失败，L1 降级跳过：${err instanceof Error ? err.message : err}`)
    }
  }

  get ready(): boolean {
    return this.model !== null
  }

  /** 分类；未训练/低于域下限返回 null（调用方继续走 L2 或直接放行） */
  classify(text: string): LocalClassifyResult | null {
    const model = this.model
    if (!model || !text.trim()) return null
    const v = tfVector(text, model.idf)
    if (v.size === 0) return null
    const sims: Record<string, number> = {}
    for (const [mode, c] of model.centroids) sims[mode] = cosine(v, c)
    const sorted = Object.entries(sims).sort((a, b) => b[1] - a[1])
    const s1 = sorted[0]?.[1] ?? 0
    const s2 = sorted[1]?.[1] ?? 0
    // 综合置信：主相似度 × 间隔占比（标定后映射到 0~1，见标定记录 upsql 47）
    const margin = s1 - s2
    const conf = Math.max(0, Math.min(1, s1 * (margin / (s1 + 0.08)) * 6.5))
    return { mode: (sorted[0]?.[0] ?? 'discuss') as ModeId, s1, margin, conf, sims }
  }
}
