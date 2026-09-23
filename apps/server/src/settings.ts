/** 模型 Provider 运行设置：API key / baseURL / 模型 ID 均可运行时自定义（不再依赖 .env 硬编码） */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FanficSearchSite } from '@story-studio/shared'

/** 官方 OpenAI 兼容端点模板（可作为 baseUrl 下拉；Anthropic/讯飞星火无 OpenAI 兼容口，不收录） */
export const OFFICIAL_PROVIDERS: Array<{ name: string; baseUrl: string }> = [
  { name: '字节｜豆包（火山方舟 Ark）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1' },
  { name: '智谱 AI GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: 'Moonshot Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '阿里通义千问（百炼 DashScope）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: '百度文心千帆（v2 兼容）', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { name: 'MiniMax', baseUrl: 'https://api.minimaxi.chat/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Google Gemini（OpenAI 兼容端点）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1' },
]

export interface ModelProvider {
  /** 唯一 id（编辑时稳定引用） */
  id: string
  /** 显示名（如 DeepSeek / 我的豆包） */
  name: string
  /** OpenAI 兼容 baseURL（自定义模式必填） */
  baseUrl: string
  /** 模型 ID（如 deepseek-chat / doubao-seed-1-6-250615） */
  modelId: string
  /**
   * 配置类型：standard=普通（单 key）；free=免费池（多账号 key 轮询）。
   * 免费池面向日日新等免费但高频 429 的端点：同 URL + 多账号 key，
   * 任一 key 触发 429 自动切换下一个重试，全程不中断对话。
   * 未配置 = standard（兼容历史数据）
   */
  kind?: 'standard' | 'free'
  /** API key（免费池 = 首个 key，兼容旧逻辑） */
  apiKey: string
  /** 免费池 key 清单（≤10 个；仅 kind='free' 时使用，其余忽略） */
  apiKeys?: string[]
  /** 可选展示名（输入栏下拉别名） */
  displayName?: string
  /** 输入上下文窗口（token）；未配置 = 按模型 ID 识别的默认容量（如 deepseek-v4=1M） */
  contextTokens?: number
  /** 单次输出 token 上限；未配置 = 默认 16384 */
  maxOutputTokens?: number
  /** 是否支持图片输入（多模态，决定输入栏附件按钮可用性）；默认 false */
  supportsImages?: boolean
  /** 采样参数：留空/未配置 = 不随请求下发（走服务端默认，DeepSeek 默认 temperature≈1.0） */
  temperature?: number
  topP?: number
  topK?: number
}

export interface SettingsFile {
  activeProviderId?: string
  providers: ModelProvider[]
  /** 浏览器偏好（扩展注入方案的浏览器选择）：'auto' | 'chrome' | 'edge' | 'firefox' | 'brave'，持久化后无需重复配置 */
  browser?: string
  /** 音乐源配置（右下角播放器）：平台 + 自部署解析 API 地址 + 登录凭据 */
  music?: MusicSettings
  /** 同人模式定向搜索源（设置中心「同人」页维护）；未配置走 DEFAULT_FANFIC_SEARCH_SITES */
  fanficSearchSites?: FanficSearchSite[]
}

/** 音乐平台：netease=网易云（推荐，配自部署 NeteaseCloudMusicApi）/ qq=QQ 音乐 / custom=自定义兼容端点 */
export type MusicPlatform = 'netease' | 'qq' | 'custom'

export interface MusicSettings {
  platform: MusicPlatform
  /** 解析 API 地址（NeteaseCloudMusicApi 协议兼容），如 http://127.0.0.1:3000 */
  apiBase: string
  /** 登录凭据（网易云扫码成功后由服务端写入，VIP 歌曲需账号本身有会员） */
  cookie?: string
}

const DEFAULTS: SettingsFile = { providers: [] }

export class SettingsStore {
  readonly file: string

  constructor(rootDir: string) {
    this.file = join(rootDir, '.local', 'settings.json')
    mkdirSync(dirname(this.file), { recursive: true })
  }

  load(): SettingsFile {
    if (!existsSync(this.file)) return { ...DEFAULTS, providers: [] }
    try {
      // 容忍 BOM（PowerShell 写文件常见坑）
      const raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')
      const data = JSON.parse(raw) as Partial<SettingsFile>
      return {
        activeProviderId: data.activeProviderId,
        providers: Array.isArray(data.providers) ? data.providers : [],
        browser: typeof data.browser === 'string' ? data.browser : undefined,
        music: data.music ?? undefined,
        fanficSearchSites: Array.isArray(data.fanficSearchSites) ? data.fanficSearchSites : undefined,
      }
    } catch (err) {
      console.error('[settings] 解析 settings.json 失败，按空配置处理:', err)
      return { ...DEFAULTS, providers: [] }
    }
  }

  save(data: SettingsFile): void {
    writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8')
  }

  /** 当前生效的 Provider（未配置返回 null → chat 走 .env 默认端点） */
  getActive(baseUrl: string, apiKey: string, modelId: string): ModelProvider | null {
    const data = this.load()
    const p = data.providers.find((x) => x.id === data.activeProviderId)
    if (!p) return null
    // 空 key 回退到 .env 的 key（升级场景下 .env 仍可能是唯一持钥处）
    return { ...p, baseUrl: p.baseUrl || baseUrl, apiKey: p.apiKey || apiKey, modelId: p.modelId || modelId }
  }
}