/** /api/music/* —— 音乐源配置 + 解析代理（右下角播放器）。
 *  音乐源走 NeteaseCloudMusicApi 协议兼容端点（官方无第三方播放 API）；
 *  本地实例由 music-api.ts 进程内自动托管（零配置），也可指到自建/远程端点。
 *  本地 Fastify 只做代理：解决浏览器 CORS + 收口 cookie，浏览器 <audio> 直播解析出的直链。 */
import type { FastifyInstance } from 'fastify'
import type { AppState } from '../state.ts'
import type { MusicPlatform } from '../settings.ts'

const PLATFORMS: readonly string[] = ['netease', 'qq', 'custom']

interface MusicSettingsBody {
  platform?: MusicPlatform
  apiBase?: string
  /** 手动粘贴的登录凭据（MUSIC_U=...；扫码登录会自动写入，一般无需手动） */
  cookie?: string
}

export function registerMusicRoutes(app: FastifyInstance, state: AppState): void {
  /** 读配置（不回传 cookie 原文，只给 loggedIn 标志） */
  app.get('/api/music/settings', async () => {
    const music = state.settings.load().music
    return {
      configured: !!music?.apiBase,
      platform: music?.platform ?? 'netease',
      apiBase: music?.apiBase ?? '',
      loggedIn: !!music?.cookie,
    }
  })

  app.put<{ Body: MusicSettingsBody }>('/api/music/settings', async (req, reply) => {
    const body = req.body ?? {}
    const platform = body.platform ?? 'netease'
    if (!PLATFORMS.includes(platform)) return reply.code(400).send({ error: `platform 取值非法（netease/qq/custom）` })
    const apiBase = (body.apiBase ?? '').trim().replace(/\/+$/, '')
    if (!apiBase) return reply.code(400).send({ error: '解析 API 地址必填（如 http://127.0.0.1:3000）' })
    const data = state.settings.load()
    const prev = data.music
    // 换端点视为换账号环境：旧 cookie 一并作废；body 显式带 cookie 时以 body 为准（手动粘贴覆盖）
    const carriedCookie = prev?.apiBase === apiBase ? prev?.cookie : undefined
    const cookie = body.cookie !== undefined ? body.cookie.trim() || undefined : carriedCookie
    const next = { ...data, music: { platform, apiBase, cookie } }
    state.settings.save(next)
    return { ok: true, configured: true, platform, apiBase, loggedIn: !!cookie }
  })

  /** 通用转发：GET {apiBase}/{path}?query&cookie&timestamp */
  async function proxy(
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
    const music = state.settings.load().music
    if (!music?.apiBase) return { ok: false, status: 400, data: null, error: '音乐源未配置，请到「设置中心 · 音乐」填写解析 API 地址' }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v)
    if (music.cookie) qs.set('cookie', music.cookie)
    qs.set('timestamp', String(Date.now()))
    try {
      const r = await fetch(`${music.apiBase}/${path}?${qs.toString()}`, { signal: AbortSignal.timeout(10_000) })
      const data = (await r.json()) as unknown
      return { ok: r.ok, status: r.status, data }
    } catch (e) {
      return { ok: false, status: 502, data: null, error: `解析服务不可达：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 搜索：result.songs[] → { id, name, artist } 精简结构 */
  app.get<{ Querystring: { keywords?: string; limit?: string } }>('/api/music/search', async (req, reply) => {
    const keywords = (req.query.keywords ?? '').trim()
    if (!keywords) return reply.code(400).send({ error: 'keywords 必填' })
    const r = await proxy('search', { keywords, limit: req.query.limit ?? '20' })
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `搜索失败（${r.status}）` })
    type Song = { id: number | string; name?: string; artists?: Array<{ name?: string }> }
    const songs = ((r.data as { result?: { songs?: Song[] } })?.result?.songs ?? []).map((s) => ({
      id: String(s.id),
      name: s.name ?? '未知曲目',
      artist: (s.artists ?? []).map((a) => a.name).filter(Boolean).join('/') || '未知歌手',
    }))
    return { songs }
  })

  /** 播放直链：song/url/v1 → data[0].url（VIP 歌曲无会员时 url 为空） */
  app.get<{ Querystring: { id?: string } }>('/api/music/song-url', async (req, reply) => {
    const id = (req.query.id ?? '').trim()
    if (!id) return reply.code(400).send({ error: 'id 必填' })
    const r = await proxy('song/url/v1', { id, level: 'standard' })
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `解析失败（${r.status}）` })
    const url = ((r.data as { data?: Array<{ url?: string | null }> })?.data ?? [])[0]?.url
    if (!url) return reply.code(404).send({ error: '拿不到播放直链（VIP 歌曲需要账号有会员，或该地区版权限制）' })
    return { url }
  })

  /** 歌词：lyric → lrc.lyric（LRC 原文）+ tlyric.lyric（翻译）；无歌词/平台不支持时两个空串 */
  app.get<{ Querystring: { id?: string } }>('/api/music/lyric', async (req, reply) => {
    const id = (req.query.id ?? '').trim()
    if (!id) return reply.code(400).send({ error: 'id 必填' })
    const r = await proxy('lyric', { id })
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `歌词获取失败（${r.status}）` })
    const d = (r.data ?? {}) as { lrc?: { lyric?: string }; tlyric?: { lyric?: string } }
    return { lyric: d.lrc?.lyric ?? '', tlyric: d.tlyric?.lyric ?? '' }
  })

  // ── 网易云扫码登录（/login/qr/* 三步；成功后 cookie 由服务端收进 settings.json）──
  app.get('/api/music/qr/start', async (_req, reply) => {
    const keyR = await proxy('login/qr/key', {})
    if (!keyR.ok) return reply.code(keyR.status).send({ error: keyR.error ?? '获取 key 失败' })
    const key = (keyR.data as { data?: { unikey?: string } })?.data?.unikey
    if (!key) return reply.code(502).send({ error: '解析服务未返回 unikey' })
    const imgR = await proxy('login/qr/create', { key, qrimg: 'true' })
    if (!imgR.ok) return reply.code(imgR.status).send({ error: imgR.error ?? '生成二维码失败' })
    const qrimg = (imgR.data as { data?: { qrimg?: string } })?.data?.qrimg
    if (!qrimg) return reply.code(502).send({ error: '解析服务未返回二维码图片' })
    return { key, qrimg }
  })

  app.get<{ Querystring: { key?: string } }>('/api/music/qr/check', async (req, reply) => {
    const key = (req.query.key ?? '').trim()
    if (!key) return reply.code(400).send({ error: 'key 必填' })
    const r = await proxy('login/qr/check', { key })
    if (!r.ok && r.status === 400) return reply.code(400).send({ error: r.error })
    type CheckResp = { code?: number; message?: string; cookie?: string }
    const d = ((r.data ?? {}) as CheckResp) ?? {}
    // 801=待扫码 802=已扫待确认 803=登录成功（cookie 在响应体） 800=二维码过期
    if (d.code === 803 && d.cookie) {
      const data = state.settings.load()
      if (data.music) state.settings.save({ ...data, music: { ...data.music, cookie: d.cookie } })
      return { code: 803, message: '登录成功' }
    }
    return { code: d.code ?? 800, message: d.message ?? '' }
  })

  // ── 个人化默认歌单（播放器浮层）：我喜欢的 + 最近在听（周榜）──
  interface PersonalSong {
    id: string
    name: string
    artist: string
  }
  /** 解析 API 的歌曲结构兼容新旧两版（ar=新版歌手 / artists=旧版） */
  function toPersonal(raw: { id?: number | string; name?: string; ar?: Array<{ name?: string }>; artists?: Array<{ name?: string }> }): PersonalSong | null {
    if (raw.id == null) return null
    const artist = (raw.ar ?? raw.artists ?? []).map((a) => a.name).filter(Boolean).join('/') || '未知歌手'
    return { id: String(raw.id), name: raw.name ?? '未知曲目', artist }
  }

  /** 未登录/解析服务异常时返回空列表（前端浮层仅剩搜索点播，无默认歌单） */
  app.get('/api/music/personal', async () => {
    const empty = { loggedIn: false, liked: [], recent: [] }
    const me = await proxy('user/account', {})
    const meData = ((me.data ?? {}) as { account?: { id?: number | string; anonimousUser?: boolean; status?: number } | null; profile?: { userId?: number | string } | null }) ?? {}
    const uid = meData.account?.id ?? meData.profile?.userId
    // 解析服务会自动注册匿名账号（anonimousUser=true / status=-10），不算登录
    const anonymous = meData.account?.anonimousUser === true || meData.account?.status === -10
    if (!uid || anonymous) return empty

    // 我喜欢的：likelist 只有 id，song/detail 补全名称（截断 100 防超长 URL）
    const liked: PersonalSong[] = []
    const likeR = await proxy('likelist', {})
    const ids = ((likeR.data ?? {}) as { ids?: Array<number | string> }).ids ?? []
    if (ids.length > 0) {
      const detR = await proxy('song/detail', { ids: ids.slice(0, 100).join(',') })
      for (const raw of ((detR.data ?? {}) as { songs?: Parameters<typeof toPersonal>[0][] }).songs ?? []) {
        const s = toPersonal(raw)
        if (s) liked.push(s)
      }
    }

    // 最近在听：user/record 周榜（type=1；按播放次数排序由服务端给出）
    const recent: PersonalSong[] = []
    const recR = await proxy('user/record', { uid: String(uid), type: '1' })
    const week = ((recR.data ?? {}) as { weekData?: Array<{ song?: Parameters<typeof toPersonal>[0] }> }).weekData ?? []
    for (const it of week) {
      if (!it.song) continue
      const s = toPersonal(it.song)
      if (s) recent.push(s)
    }

    return { loggedIn: true, liked: liked.slice(0, 100), recent: recent.slice(0, 50) }
  })
}
