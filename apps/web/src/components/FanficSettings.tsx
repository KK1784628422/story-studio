/**
 * 设置中心「同人」页：同人模式定向搜索源清单维护。
 * - GET /api/settings 读 fanficSearchSites（未配置时服务端返回默认清单）；
 * - 每行 站点名 + 域名 编辑、删除、底部「添加」「恢复默认」；
 * - 保存 PUT /api/settings { fanficSearchSites }（服务端清洗：≤12 条、域名合法、id 唯一）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { FanficSearchSite } from '@story-studio/shared'
import { DEFAULT_FANFIC_SEARCH_SITES } from '@story-studio/shared'
import { Icon } from './Icon.tsx'

interface SettingsResp {
  fanficSearchSites?: FanficSearchSite[]
}

function newId(): string {
  return `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function FanficSettings(): React.JSX.Element {
  const [sites, setSites] = useState<FanficSearchSite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/settings', { cache: 'no-store' })
      if (r.ok) {
        const data = (await r.json()) as SettingsResp
        setSites(Array.isArray(data.fanficSearchSites) ? data.fanficSearchSites : [])
      }
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (next: FanficSearchSite[]) => {
    setBusy(true)
    setErr('')
    setMsg('')
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fanficSearchSites: next }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? `保存失败（${r.status}）`)
      const data = (await r.json()) as SettingsResp
      setSites(Array.isArray(data.fanficSearchSites) ? data.fanficSearchSites : next)
      setMsg('已保存')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const update = (id: string, patch: Partial<FanficSearchSite>) => {
    setSites((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  if (loading) return <div className="fanfic-settings-loading">加载中…</div>

  return (
    <div className="fanfic-settings">
      <div className="fanfic-settings-tip">
        同人模式第 1 步检索原著设定时，Agent 会先自由搜索，再逐站用 <code>site:域名</code> 定向补全。
        列表为空时只做自由搜索。
      </div>

      <div className="fanfic-site-list">
        {sites.map((s) => (
          <div key={s.id} className="fanfic-site-row">
            <input
              type="text"
              className="fanfic-site-name"
              value={s.name}
              placeholder="站点名"
              maxLength={20}
              onChange={(e) => update(s.id, { name: e.target.value })}
            />
            <input
              type="text"
              className="fanfic-site-host"
              value={s.host}
              placeholder="如 zh.moegirl.org.cn"
              onChange={(e) => update(s.id, { host: e.target.value })}
            />
            <button
              type="button"
              className="fanfic-site-del"
              title="删除该站点"
              onClick={() => setSites((cur) => cur.filter((x) => x.id !== s.id))}
            >
              <Icon name="x-circle" size={13} />
            </button>
          </div>
        ))}
        {sites.length === 0 && <div className="fanfic-site-empty">暂无搜索源（仅自由搜索）</div>}
      </div>

      <div className="fanfic-settings-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setSites((cur) => [...cur, { id: newId(), name: '', host: '' }])}
        >
          ＋ 添加站点
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setSites(DEFAULT_FANFIC_SEARCH_SITES.map((s) => ({ ...s })))}
        >
          恢复默认
        </button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save(sites)}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {msg && <div className="fanfic-settings-msg">{msg}</div>}
      {err && <div className="fanfic-settings-err">{err}</div>}
    </div>
  )
}
