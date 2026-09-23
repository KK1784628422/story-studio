/** GET/PUT /api/settings —— 模型 Provider + 浏览器偏好配置（本地持久化 .local/settings.json） */
import type { FastifyInstance } from 'fastify'
import type { FanficSearchSite } from '@story-studio/shared'
import { DEFAULT_FANFIC_SEARCH_SITES } from '@story-studio/shared'
import type { AppState } from '../state.ts'
import { OFFICIAL_PROVIDERS, type ModelProvider, type SettingsFile } from '../settings.ts'
import { probeBrowsers, detectBrowserFromUA } from '../browserProbe.ts'

/** 合法浏览器偏好（auto=跟随用户打开 Story Studio 的浏览器） */
const BROWSER_IDS = ['auto', 'chrome', 'edge', 'firefox', 'brave', 'safari'] as const

/** 数值清洗：非法/越界返回 undefined（丢弃该字段，回退默认行为） */
const numOrUndef = (v: unknown, min: number, max: number, integer = false): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < min || n > max) return undefined
  return integer ? Math.round(n) : n
}

/**
 * 免费池 key 清单清洗：主 key 优先、去空白去重、上限 10 个。
 * 非法/空输入返回 undefined（保持原值，兼容旧数据）。
 */
function sanitizeKeyPool(keys: unknown, primary: unknown): string[] | undefined {
  const pool: string[] = []
  const seen = new Set<string>()
  const push = (k: unknown) => {
    if (typeof k !== 'string') return
    const t = k.trim()
    if (!t || t.length < 4 || t.length > 1024 || /\s/.test(t) || seen.has(t)) return
    seen.add(t)
    pool.push(t)
  }
  push(primary)
  if (Array.isArray(keys)) {
    for (const k of keys) {
      push(k)
      if (pool.length >= 10) break
    }
  }
  if (pool.length === 0) return undefined
  return pool.slice(0, 10)
}

/** Provider 数值/布尔字段清洗：保留合法值，非法值丢弃（不报错——容忍前端旧版本/手改 settings.json） */
function sanitizeProvider(p: ModelProvider): ModelProvider {
  // 免费池：key 池归一化（apiKey=首个 key）；kind 非 'free' 或池不足 2 个 key（无法轮询）一律按普通模型处理
  const free = p.kind === 'free'
  const keys = free ? sanitizeKeyPool(p.apiKeys, p.apiKey) : undefined
  return {
    ...p,
    kind: free && keys && keys.length >= 2 ? 'free' : 'standard',
    apiKeys: keys,
    apiKey: keys?.[0] ?? p.apiKey,
    contextTokens: numOrUndef(p.contextTokens, 1_000, 10_000_000, true),
    maxOutputTokens: numOrUndef(p.maxOutputTokens, 1_000, 2_000_000, true),
    supportsImages: p.supportsImages === true,
    temperature: numOrUndef(p.temperature, 0, 2),
    topP: numOrUndef(p.topP, 0, 1),
    topK: numOrUndef(p.topK, 1, 100, true),
  }
}

/** 同人搜索源清洗：≤12 条、name ≤20 字、host 形如 a.b、id 必填且唯一；全非法返回 undefined（走默认） */
function sanitizeFanficSites(v: unknown): FanficSearchSite[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: FanficSearchSite[] = []
  const seen = new Set<string>()
  for (const raw of v) {
    const s = raw as Partial<FanficSearchSite>
    const id = typeof s.id === 'string' ? s.id.trim().slice(0, 40) : ''
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 20) : ''
    const host = typeof s.host === 'string' ? s.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
    if (!id || !name || !/^[\w.-]+\.[a-z]{2,}$/.test(host) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, host })
    if (out.length >= 12) break
  }
  return out
}

interface PutBody {
  activeProviderId?: string
  providers?: ModelProvider[]
  /** 便捷单条：{ provider, active } 追加/替换并可选激活 */
  provider?: ModelProvider
  active?: boolean
  /** 删除指定 provider */
  removeId?: string
  /** 浏览器偏好：'auto' | 'chrome' | 'edge' | 'firefox' | 'brave' */
  browser?: string
  /** 同人模式定向搜索源（空数组=清空后走默认；非法条目被清洗丢弃） */
  fanficSearchSites?: FanficSearchSite[]
}

export function registerSettingsRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/settings', async (req) => {
    const data = state.settings.load()
    const active = state.settings.getActive(state.env.baseUrl, state.env.apiKey, state.env.modelId)
    return {
      ...data,
      browser: data.browser ?? 'auto',
      // 同人搜索源：未配置返回默认清单（前端同人设置页直接可编辑）
      fanficSearchSites: data.fanficSearchSites ?? DEFAULT_FANFIC_SEARCH_SITES,
      browserOptions: probeBrowsers(),
      // 实时识别用户打开 Story Studio 的浏览器（不用手动配置，扩展注入装到这个浏览器）
      detectedBrowser: detectBrowserFromUA(req.headers['user-agent']),
      active: active
        ? { name: active.name, baseUrl: active.baseUrl, modelId: active.modelId, displayName: active.displayName ?? active.name }
        : null,
      officialProviders: OFFICIAL_PROVIDERS,
    }
  })

  app.put<{ Body: PutBody }>('/api/settings', async (req, reply) => {
    const data = state.settings.load()
    const body = req.body ?? ({} as PutBody)
    let next: SettingsFile = { ...data, providers: [...data.providers] }

    if (body.provider) {
      const p = body.provider
      if (!p.baseUrl?.trim() || !p.modelId?.trim()) {
        return reply.code(400).send({ error: 'baseURL 与模型 ID 必填' })
      }
      next.providers = next.providers.filter((x) => x.id !== p.id)
      next.providers = [...next.providers, sanitizeProvider(p)]
      if (body.active !== false) next.activeProviderId = p.id
    }

    if (body.removeId) {
      next.providers = next.providers.filter((x) => x.id !== body.removeId)
      if (next.activeProviderId === body.removeId) next.activeProviderId = next.providers.at(-1)?.id
    }

    if (body.providers !== undefined) next.providers = body.providers
    if (body.activeProviderId !== undefined) next.activeProviderId = body.activeProviderId
    // 浏览器偏好：仅接受合法值，非法忽略（保持原值）
    if (body.browser !== undefined) {
      if ((BROWSER_IDS as readonly string[]).includes(body.browser)) next.browser = body.browser
      else return reply.code(400).send({ error: `browser 取值非法（${BROWSER_IDS.join('/')}）` })
    }

    // 同人搜索源：显式传入（含空数组）才覆盖；清洗后为空数组 = 用户清空（聊天里只剩自由搜索）
    if (body.fanficSearchSites !== undefined) {
      next.fanficSearchSites = sanitizeFanficSites(body.fanficSearchSites) ?? []
    }

    state.settings.save(next)
    return { ok: true, ...next, browser: next.browser ?? 'auto' }
  })
}