/** 模型 Provider 设置（设置中心「模型」页签内容）：官方模板 / 自定义（baseURL + 模型ID + API key + 显示名）。
 *  纯内容组件，弹窗外壳由 components/SettingsModal.tsx 统一提供。 */
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon.tsx'

interface OfficialProv {
  name: string
  baseUrl: string
}
interface Prov {
  id: string
  name: string
  baseUrl: string
  modelId: string
  apiKey: string
  /** standard=普通模型；free=免费池（多账号 key，429 自动轮询切换） */
  kind?: 'standard' | 'free'
  /** 免费池 key 清单（≤10；仅 kind='free'） */
  apiKeys?: string[]
  displayName?: string
  /** 输入上下文窗口（token）；未配置 = 模型默认容量 */
  contextTokens?: number
  /** 单次输出 token 上限；未配置 = 16384 */
  maxOutputTokens?: number
  /** 是否支持图片输入（多模态）；默认 false */
  supportsImages?: boolean
  temperature?: number
  topP?: number
  topK?: number
}

/** 表单数值解析：空串 → undefined（不下发，走服务端默认）；非数字原样提交由服务端清洗丢弃 */
const parseNum = (s: string): number | undefined => {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 快捷档位（token 数值）：上下文输入 / 输出上限 */
const CONTEXT_PRESETS: Array<[string, number]> = [
  ['128k', 131_072],
  ['256k', 262_144],
  ['512k', 524_288],
  ['1M', 1_048_576],
]
const OUTPUT_PRESETS: Array<[string, number]> = [
  ['4k', 4_096],
  ['16k', 16_384],
  ['32k', 32_768],
  ['128k', 131_072],
]

/** 滑条范围（与 UI 一致的固定区间；服务端清洗范围更宽，手改 settings.json 不受限） */
const TEMP_RANGE = { min: 0.8, max: 1.2, def: 1.05 } as const
const TOP_P_RANGE = { min: 0.85, max: 0.98, def: 0.95 } as const

/** 滑条已填充轨道百分比（钳位 0-100）；--fill 供 CSS 渐变轨道使用 */
const sliderFill = (val: number, r: { min: number; max: number }): string =>
  `${Math.max(0, Math.min(100, ((val - r.min) / (r.max - r.min)) * 100))}%`

export function ModelSettings({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [official, setOfficial] = useState<OfficialProv[]>([])
  const [providers, setProviders] = useState<Prov[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()

  const [mode, setMode] = useState<'official' | 'custom'>('official')
  /** 普通（单 key）/ 免费池（多账号 key 轮询，429 自动换 key） */
  const [kind, setKind] = useState<'standard' | 'free'>('standard')
  const [selOfficial, setSelOfficial] = useState('DeepSeek 深度求索')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [name, setName] = useState('')
  /** 免费池 key 文本（每行一个；保存时解析去重、上限 10 个） */
  const [txtKeys, setTxtKeys] = useState('')
  // 高级配置（字符串 state：空串 = 未配置；保存时 parseNum）
  const [contextTokens, setContextTokens] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState('')
  const [supportsImages, setSupportsImages] = useState(false)
  const [temperature, setTemperature] = useState('')
  const [topP, setTopP] = useState('')
  const [topK, setTopK] = useState('')
  /** 高级设置折叠展开（默认收起；折叠标题摘要行提示已配置项，编辑已配置 Provider 也不自动展开） */
  const [advOpen, setAdvOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  /** 正在编辑的已保存配置 id（null = 新建） */
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/settings')
        const d = (await r.json()) as {
          officialProviders?: OfficialProv[]
          providers?: Prov[]
          activeProviderId?: string
          active?: { name: string; baseUrl: string; modelId: string; displayName?: string } | null
        }
        setOfficial(d.officialProviders ?? [])
        setProviders(d.providers ?? [])
        setActiveId(d.activeProviderId)
        if (d.officialProviders?.length) {
          const first = d.officialProviders[0]
          setSelOfficial(first.name)
          setBaseUrl(first.baseUrl)
        }
        const act = d.providers?.find((p) => p.id === d.activeProviderId)
        if (act) {
          setMode('custom')
          setKind(act.kind === 'free' ? 'free' : 'standard')
          setBaseUrl(act.baseUrl)
          setModelId(act.modelId)
          setApiKey(act.apiKey ?? '')
          setTxtKeys((act.apiKeys ?? []).join('\n'))
          setName(act.displayName ?? act.name)
          setContextTokens(act.contextTokens != null ? String(act.contextTokens) : '')
          setMaxOutputTokens(act.maxOutputTokens != null ? String(act.maxOutputTokens) : '')
          setSupportsImages(act.supportsImages === true)
          setTemperature(act.temperature != null ? String(act.temperature) : '')
          setTopP(act.topP != null ? String(act.topP) : '')
          setTopK(act.topK != null ? String(act.topK) : '')
        }
      } catch {
        /* 服务不可达静默 */
      }
    })()
  }, [])

  const pickOfficial = (n: string) => {
    setSelOfficial(n)
    const hit = official.find((o) => o.name === n)
    if (hit) setBaseUrl(hit.baseUrl)
  }

  /** 官方模式下 baseURL 与模板不一致（历史残留 / 手改），警示 + 可一键同步 */
  const officialHit = official.find((o) => o.name === selOfficial)
  const officialMismatch = mode === 'official' && !!officialHit && baseUrl.trim() !== officialHit.baseUrl

  const editProvider = (p: Prov) => {
    setEditingId(p.id)
    setMode('custom')
    setKind(p.kind === 'free' ? 'free' : 'standard')
    setBaseUrl(p.baseUrl)
    setModelId(p.modelId)
    setApiKey(p.apiKey ?? '')
    setTxtKeys((p.apiKeys ?? []).join('\n'))
    setName(p.displayName ?? p.name)
    setContextTokens(p.contextTokens != null ? String(p.contextTokens) : '')
    setMaxOutputTokens(p.maxOutputTokens != null ? String(p.maxOutputTokens) : '')
    setSupportsImages(p.supportsImages === true)
    setTemperature(p.temperature != null ? String(p.temperature) : '')
    setTopP(p.topP != null ? String(p.topP) : '')
    setTopK(p.topK != null ? String(p.topK) : '')
    setMsg('')
    window.scrollTo?.(0, 0)
  }

  const resetNew = () => {
    setEditingId(null)
    setMode('official')
    setKind('standard')
    setModelId('')
    setApiKey('')
    setTxtKeys('')
    setName('')
    setContextTokens('')
    setMaxOutputTokens('')
    setSupportsImages(false)
    setTemperature('')
    setTopP('')
    setTopK('')
    const hit = official.find((o) => o.name === selOfficial)
    setBaseUrl(hit ? hit.baseUrl : '')
    setMsg('')
  }

  const save = async () => {
    if (!modelId.trim() || !baseUrl.trim()) {
      setMsg('模型 ID 与 baseURL 必填')
      return
    }
    // 免费池：解析多 key（每行一个 → 去空去重 → 上限 10）；普通模式沿用单 key 校验
    const isFree = kind === 'free'
    const keys = isFree
      ? [...new Set(txtKeys.split('\n').map((s) => s.trim()).filter(Boolean))].slice(0, 10)
      : []
    if (isFree && keys.length < 2) {
      setMsg('免费池至少需要 2 个 API key（1 个 key 无法轮询；每行一个，最多 10 个）')
      return
    }
    if (!isFree && !apiKey.trim()) {
      setMsg('API key 必填（或留空沿用 .env 的 key）')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      const id = editingId ?? `p-${Date.now()}`
      // 官方模板：名称=服务商名、不带 displayName（不沿用之前自定义配置的名称）
      const isOfficial = mode === 'official'
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: {
            id,
            name: isOfficial ? selOfficial : name.trim() || (isFree ? '免费池' : '自定义'),
            baseUrl: baseUrl.trim(),
            modelId: modelId.trim(),
            apiKey: isFree ? keys[0]! : apiKey.trim(),
            // 免费池：kind + 多 key 清单（服务端再清洗去重校验）；普通=单 key
            kind: isFree ? 'free' : 'standard',
            apiKeys: isFree ? keys : undefined,
            displayName: isOfficial ? undefined : name.trim() || undefined,
            // 高级配置：空 = undefined（JSON.stringify 丢弃，服务端按未配置处理）
            contextTokens: parseNum(contextTokens),
            maxOutputTokens: parseNum(maxOutputTokens),
            supportsImages,
            temperature: parseNum(temperature),
            topP: parseNum(topP),
            topK: parseNum(topK),
          },
          active: true,
        }),
      })
      const d = (await r.json()) as { error?: string; providers?: Prov[]; activeProviderId?: string }
      if (!r.ok) return setMsg(d.error ?? '保存失败')
      setProviders(d.providers ?? [])
      setActiveId(d.activeProviderId)
      setEditingId(null)
      setMsg(editingId ? '已保存修改并激活，下次对话生效' : '已保存并激活，下次对话生效')
      onSaved()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  const activate = async (id: string) => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeProviderId: id }),
    })
    setActiveId(id)
    onSaved()
  }

  const remove = async (id: string) => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removeId: id }),
    })
    setProviders((ps) => ps.filter((p) => p.id !== id))
    onSaved()
  }

  return (
    <div className="model-settings">
      <div className="settings-body">
          <div className="settings-row">
            <label className="settings-label">配置模式</label>
            <div className="settings-radios">
              <label className="radio-inline">
                <input
                  type="radio"
                  checked={mode === 'official'}
                  onChange={() => {
                    setMode('official')
                    // 切官方模板即同步该模板的 baseURL（避免沿用自定义配置残留的 URL/名称）
                    const hit = official.find((o) => o.name === selOfficial)
                    if (hit) setBaseUrl(hit.baseUrl)
                  }}
                /> 官方模板
              </label>
              <label className="radio-inline">
                <input type="radio" checked={mode === 'custom' && kind === 'standard'} onChange={() => { setMode('custom'); setKind('standard') }} /> 自定义
              </label>
              <label className="radio-inline">
                <input type="radio" checked={kind === 'free'} onChange={() => { setMode('custom'); setKind('free') }} /> 免费池
              </label>
            </div>
          </div>
          <div className="settings-hint">
            {kind === 'free'
              ? '免费池：面向免费但经常 429 的端点（如日日新）。同一 baseURL 下配置多个账号的 key，任一 key 触发限流（429）会<strong>自动切换到下一个 key 重试，不中断对话</strong>；失败 key 自动降权轮换。'
              : '官方模板 = 服务商固定地址；自定义 = 单 key 手动配置。'}
          </div>

          {mode === 'official' ? (
            <div className="settings-row">
              <label className="settings-label">服务商</label>
              <select className="settings-select" value={selOfficial} onChange={(e) => pickOfficial(e.target.value)}>
                {official.map((o) => (
                  <option key={o.name} value={o.name}>{o.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="settings-row">
              <label className="settings-label">服务商名称（显示名）</label>
              <input className="settings-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的豆包" />
            </div>
          )}

          <div className="settings-row">
            <label className="settings-label">OpenAI 兼容 baseURL</label>
            <input className="settings-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
          </div>
          {officialMismatch && (
            <div className="settings-warn">
              ⚠ baseURL 与「{officialHit!.name}」官方地址不一致——残留的错误地址是 401 鉴权失败的常见原因。
              <button type="button" className="btn-ghost" onClick={() => setBaseUrl(officialHit!.baseUrl)}>
                同步官方地址
              </button>
            </div>
          )}
          <div className="settings-row">
            <label className="settings-label">模型 ID</label>
            <input className="settings-input" value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="deepseek-chat / doubao-seed-…" spellCheck={false} />
          </div>
          {kind === 'free' ? (
            <div className="settings-row">
              <label className="settings-label">API keys<br /><small style={{ fontWeight: 400 }}>每行一个，最少 2 个、最多 10 个</small></label>
              <textarea
                className="settings-input settings-textarea"
                rows={4}
                value={txtKeys}
                onChange={(e) => setTxtKeys(e.target.value)}
                placeholder={'sk-账号1的key\nsk-账号2的key'}
                spellCheck={false}
              />
            </div>
          ) : (
            <div className="settings-row">
              <label className="settings-label">API key</label>
              <input className="settings-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…（留空沿用 .env）" spellCheck={false} />
            </div>
          )}

          {/* ---- 高级设置（默认折叠）：上下文窗口 / 输出上限 / 图片输入 / 采样参数 ---- */}
          <div className="settings-adv-fold">
            <button type="button" className="settings-adv-toggle" onClick={() => setAdvOpen((v) => !v)}>
              <span className={`settings-adv-chevron${advOpen ? ' open' : ''}`}>▸</span>
              <span className="settings-adv-title">高级设置</span>
              <span className="settings-adv-summary">
                {(() => {
                  const parts: string[] = []
                  if (contextTokens.trim()) parts.push(`上下文 ${contextTokens.trim()}`)
                  if (maxOutputTokens.trim()) parts.push(`输出 ${maxOutputTokens.trim()}`)
                  if (supportsImages) parts.push('图片')
                  if (temperature.trim() || topP.trim() || topK.trim())
                    parts.push(`T ${temperature.trim() || '—'} / P ${topP.trim() || '—'}`)
                  return parts.length > 0 ? `已配置：${parts.join(' · ')}` : '上下文 / 输出 / 图片 / 采样（默认）'
                })()}
              </span>
            </button>
            {advOpen && (
              <div className="settings-adv-body">
                <div className="settings-row">
                  <label className="settings-label">上下文窗口（输入 token）</label>
                  <div className="settings-adv-group">
                    <input className="settings-input" value={contextTokens} onChange={(e) => setContextTokens(e.target.value)} placeholder="留空 = 模型默认容量（deepseek-v4=1M、glm-5=200k）" spellCheck={false} inputMode="numeric" />
                    <div className="settings-chip-row">
                      {CONTEXT_PRESETS.map(([label, val]) => (
                        <button key={label} type="button" className={`settings-chip${parseNum(contextTokens) === val ? ' on' : ''}`} onClick={() => setContextTokens(String(val))}>{label}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="settings-row">
                  <label className="settings-label">输出上限（token）</label>
                  <div className="settings-adv-group">
                    <input className="settings-input" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)} placeholder="留空 = 默认 16384（写长章建议 32768）" spellCheck={false} inputMode="numeric" />
                    <div className="settings-chip-row">
                      {OUTPUT_PRESETS.map(([label, val]) => (
                        <button key={label} type="button" className={`settings-chip${parseNum(maxOutputTokens) === val ? ' on' : ''}`} onClick={() => setMaxOutputTokens(String(val))}>{label}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="settings-row">
                  <label className="settings-label">支持图片输入</label>
                  <div className="settings-radios">
                    <label className="radio-inline">
                      <input type="radio" checked={supportsImages} onChange={() => setSupportsImages(true)} /> 支持（多模态，输入栏可传图）
                    </label>
                    <label className="radio-inline">
                      <input type="radio" checked={!supportsImages} onChange={() => setSupportsImages(false)} /> 不支持（默认）
                    </label>
                  </div>
                </div>
                <div className="settings-row">
                  <label className="settings-label">采样参数</label>
                  <div className="settings-adv-group">
                    <div className="settings-slider-row">
                      <span className="settings-slider-name">Temperature</span>
                      <input
                        type="range"
                        className="settings-slider"
                        style={{ '--fill': sliderFill(temperature === '' ? TEMP_RANGE.def : Number(temperature), TEMP_RANGE) } as React.CSSProperties}
                        min={TEMP_RANGE.min}
                        max={TEMP_RANGE.max}
                        step={0.01}
                        value={temperature === '' ? TEMP_RANGE.def : Number(temperature)}
                        onChange={(e) => setTemperature(Number(e.target.value).toFixed(2))}
                      />
                      <span className="settings-slider-range">0.8–1.2</span>
                      <span className="settings-slider-value">{temperature === '' ? '默认' : temperature}</span>
                    </div>
                    <div className="settings-slider-row">
                      <span className="settings-slider-name">Top P</span>
                      <input
                        type="range"
                        className="settings-slider"
                        style={{ '--fill': sliderFill(topP === '' ? TOP_P_RANGE.def : Number(topP), TOP_P_RANGE) } as React.CSSProperties}
                        min={TOP_P_RANGE.min}
                        max={TOP_P_RANGE.max}
                        step={0.01}
                        value={topP === '' ? TOP_P_RANGE.def : Number(topP)}
                        onChange={(e) => setTopP(Number(e.target.value).toFixed(2))}
                      />
                      <span className="settings-slider-range">0.85–0.98</span>
                      <span className="settings-slider-value">{topP === '' ? '默认' : topP}</span>
                    </div>
                    <div className="settings-slider-row">
                      <span className="settings-slider-name">Top K</span>
                      <input className="settings-input" value={topK} onChange={(e) => setTopK(e.target.value)} placeholder="多数端点不支持，建议留空" spellCheck={false} inputMode="numeric" />
                    </div>
                    <div className="settings-chip-row">
                      <button
                        type="button"
                        className="settings-chip"
                        title="Temperature 1.05 + Top P 0.95：文笔多样且剧情稳定"
                        onClick={() => {
                          setTemperature('1.05')
                          setTopP('0.95')
                        }}
                      >
                        小说创作推荐（T 1.05 / P 0.95）
                      </button>
                      <button
                        type="button"
                        className="settings-chip"
                        title="清空全部采样参数，请求不携带（走服务端默认）"
                        onClick={() => {
                          setTemperature('')
                          setTopP('')
                          setTopK('')
                        }}
                      >
                        清空（走默认）
                      </button>
                    </div>
                    <div className="settings-hint">
                      默认（未拖动滑条）= 请求不携带采样参数，走模型服务默认（DeepSeek≈1.0）。Temperature 越高文字越发散、越低越确定，滑条范围 0.8–1.2；Top P 范围 0.85–0.98，与 Temperature 二选一微调即可；小说创作推荐 1.05 / 0.95。Top K 多数 OpenAI 兼容端点不支持，建议留空。
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="settings-row">
            <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : <><Icon name="save-floppy" size={13} /> {editingId ? '保存修改并激活' : '保存并激活'}</>}
            </button>
            {editingId && (
              <button type="button" className="btn-ghost" onClick={resetNew}>
                取消编辑（新建）
              </button>
            )}
            <span className="settings-msg">{msg}</span>
          </div>

          {providers.length > 0 && (
            <div className="settings-row">
              <label className="settings-label">已保存配置</label>
              <div className="settings-list">
                {providers.map((p) => (
                  <div key={p.id} className={`settings-item ${activeId === p.id ? 'active' : ''}`}>
                    <div className="settings-item-info">
                      <b>
                        {p.displayName ?? p.name}
                        {p.kind === 'free' && <span className="settings-free-tag" title={`免费池：${p.apiKeys?.length ?? 1} 个账号 key 自动轮询（429 自动切换）`}>FREE×{p.apiKeys?.length ?? 1}</span>}
                        {editingId === p.id && <span className="settings-editing-tag">编辑中</span>}
                      </b>
                      <span>{p.modelId} @ {p.baseUrl}</span>
                    </div>
                    <div className="settings-item-actions">
                      {activeId !== p.id && (
                        <button type="button" className="btn-ghost" onClick={() => void activate(p.id)}>激活</button>
                      )}
                      <button type="button" className="btn-ghost" onClick={() => editProvider(p)}>编辑</button>
                      <button type="button" className="btn-ghost" onClick={() => void remove(p.id)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
    </div>
  )
}