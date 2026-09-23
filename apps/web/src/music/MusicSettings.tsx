/**
 * 设置中心 · 音乐页签：音乐源配置。
 * 平台音源无官方第三方播放 API，走 NeteaseCloudMusicApi 协议兼容端点：
 *  - 本地解析 API 由 server 进程内自动托管（apps/server/src/music-api.ts），开箱即用；
 *  - 也可自建/远程部署（改「解析 API 地址」，如 docker 起的实例）；
 *  - 网易云支持扫码登录（cookie 由服务端收进 .local/settings.json，VIP 歌曲需账号本身有会员）
 * 保存/扫码登录后刷新 nowPlaying store 的配置快照，顶栏右岛即时从「音乐未配置/未登录」变为可播放。
 */
import { useEffect, useRef, useState } from 'react'
import {
  fetchMusicSettings,
  musicQrCheck,
  musicQrStart,
  saveMusicSettings,
  type MusicPlatform,
  type MusicSettingsInfo,
} from '../api.ts'
import { refreshMusicConfig } from '../music/nowPlaying.ts'

const PLATFORM_OPTIONS: Array<{ id: MusicPlatform; label: string; hint: string }> = [
  { id: 'netease', label: '网易云', hint: '推荐 · 配自部署 NeteaseCloudMusicApi，支持扫码登录' },
  { id: 'qq', label: 'QQ 音乐', hint: '需自建同协议解析服务，稳定性依赖你的服务' },
  { id: 'custom', label: '自定义 API', hint: '任何实现 search / song-url 路由的兼容端点' },
]

/** 扫码状态机：idle=未开始 / waiting=展示二维码轮询中 / done=成功 / expired=过期 */
type QrPhase = 'idle' | 'waiting' | 'done' | 'expired'

export function MusicSettings(): React.JSX.Element {
  const [info, setInfo] = useState<MusicSettingsInfo | null>(null)
  const [platform, setPlatform] = useState<MusicPlatform>('netease')
  const [apiBase, setApiBase] = useState('')
  const [cookieInput, setCookieInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const [qrPhase, setQrPhase] = useState<QrPhase>('idle')
  const [qrImg, setQrImg] = useState('')
  const [qrHint, setQrHint] = useState('')
  const qrKeyRef = useRef('')
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetchMusicSettings()
      .then((d) => {
        setInfo(d)
        setPlatform(d.platform)
        setApiBase(d.apiBase)
      })
      .catch(() => setMsg({ kind: 'bad', text: '读取音乐源配置失败' }))
    return () => {
      if (qrTimerRef.current) clearInterval(qrTimerRef.current)
    }
  }, [])

  const stopPolling = (): void => {
    if (qrTimerRef.current) {
      clearInterval(qrTimerRef.current)
      qrTimerRef.current = null
    }
  }

  const save = async (): Promise<void> => {
    if (!apiBase.trim() || saving) return
    setSaving(true)
    setMsg(null)
    try {
      // cookie 仅在用户填写了才随保存提交（空 = 保留既有凭据，避免误清扫码结果）
      const c = cookieInput.trim()
      const d = await saveMusicSettings(platform, apiBase.trim(), c === '' ? undefined : c)
      setInfo(d)
      void refreshMusicConfig()
      setCookieInput('')
      setMsg({ kind: 'ok', text: d.loggedIn ? '已保存，右下角播放器可搜索点播' : '已保存，扫码登录后右下角播放器可搜索点播' })
    } catch (e) {
      setMsg({ kind: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  /** 扫码登录：拿 key+二维码 → 2.5s 轮询 check（801 等待 / 802 已扫 / 803 成功 / 800 过期） */
  const startQr = async (): Promise<void> => {
    stopPolling()
    setQrPhase('waiting')
    setQrHint('正在生成二维码…')
    try {
      const { key, qrimg } = await musicQrStart()
      qrKeyRef.current = key
      setQrImg(qrimg)
      setQrHint('请用网易云音乐 App 扫码')
      qrTimerRef.current = setInterval(async () => {
        try {
          const r = await musicQrCheck(key)
          if (r.code === 803) {
            stopPolling()
            setQrPhase('done')
            setQrHint('登录成功')
            const d = await fetchMusicSettings()
            setInfo(d)
            // 同步 nowPlaying store 快照：右岛/右下角播放器即时解锁，无需刷新页面
            void refreshMusicConfig()
          } else if (r.code === 802) {
            setQrHint('已扫码，请在手机上确认')
          } else if (r.code === 800) {
            stopPolling()
            setQrPhase('expired')
            setQrHint('二维码已过期')
          }
        } catch {
          // 瞬断不打断轮询
        }
      }, 2500)
    } catch (e) {
      setQrPhase('expired')
      setQrHint(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="music-settings">
      <div className="ms-hint">
        本地解析 API 已由应用<strong>内置自动启动</strong>（NeteaseCloudMusicApi 协议，随服务端托管，无需手动部署），开箱即可搜索点播。
        扫码登录后凭据自动写入（凭据即 key，无需手动申请），下方列表会显示你喜欢的歌曲和最近在听；VIP 歌曲需要你的账号本身有会员。
        有自建/远程端点时改「解析 API 地址」即可；配置并登录后右下角播放器才会出现（不登录不提供任何默认歌单）。
      </div>

      <div className="ms-row">
        <span className="ms-label">平台</span>
        <div className="ms-platforms">
          {PLATFORM_OPTIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`ms-platform${platform === p.id ? ' on' : ''}`}
              title={p.hint}
              onClick={() => setPlatform(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ms-row-hint">{PLATFORM_OPTIONS.find((p) => p.id === platform)?.hint}</div>

      <div className="ms-row">
        <span className="ms-label">解析 API 地址</span>
        <input
          className="ms-input"
          value={apiBase}
          placeholder="如 http://127.0.0.1:3000"
          onChange={(e) => setApiBase(e.target.value)}
        />
        <button type="button" className="btn-primary ms-save" disabled={!apiBase.trim() || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      <div className="ms-row">
        <span className="ms-label">网易云登录</span>
        {info?.loggedIn ? (
          <span className="ms-logged-in">✓ 已登录（会员歌曲以账号权益为准）</span>
        ) : (
          <button type="button" className="btn-ghost" disabled={!info?.configured} onClick={() => void startQr()}>
            扫码登录
          </button>
        )}
      </div>

      <div className="ms-row">
        <span className="ms-label">手动凭据</span>
        <input
          className="ms-input"
          value={cookieInput}
          placeholder="可选 · 粘贴 MUSIC_U=...（扫码登录会自动写入，一般无需手动）"
          onChange={(e) => setCookieInput(e.target.value)}
        />
      </div>

      {qrPhase === 'waiting' && (
        <div className="ms-qr">
          {qrImg ? <img src={qrImg} alt="网易云登录二维码" /> : <span className="ms-qr-loading">…</span>}
          <span>{qrHint}</span>
        </div>
      )}
      {qrPhase === 'expired' && (
        <div className="ms-qr">
          <span>{qrHint}</span>
          <button type="button" className="btn-ghost" onClick={() => void startQr()}>
            重新生成
          </button>
        </div>
      )}

      {msg && <div className={`ms-msg ${msg.kind}`}>{msg.text}</div>}
    </div>
  )
}
