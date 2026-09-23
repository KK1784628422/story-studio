/**
 * 统一图标组件：<Icon name="brain" size={16} />
 * - 图标源：src/assets/icons/*.svg（Vite 构建期全量内联，新增文件无需改这里）
 * - 归一化：剥 XML 头/固定 width height；fill / stroke 颜色统一改 currentColor
 *   （颜色随文字 CSS color 变化，红牌黄牌禁用态等自动适配）
 * - 文件名即 name：小写 kebab-case，如 brain.svg → <Icon name="brain" />
 */
import type { CSSProperties } from 'react'

const modules = import.meta.glob('../assets/icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function normalize(raw: string, keepColor = false): string {
  let svg = raw.slice(raw.indexOf('<svg'))
  // 部分图标（如 agent.svg）没有 viewBox 只有固定 width/height——先提取，
  // 剥掉固定尺寸后补注入 viewBox，否则 SVG 按默认 300×150 渲染、大坐标路径被裁剪成空白
  const wm = svg.match(/\swidth="(\d+(?:\.\d+)?)[a-z]*"/i)
  const hm = svg.match(/\sheight="(\d+(?:\.\d+)?)[a-z]*"/i)
  const hasViewBox = /viewBox=/i.test(svg)
  svg = svg.replace(/\s(width|height)="[^"]*"/g, '')
  if (!hasViewBox && wm && hm) {
    svg = svg.replace(/<svg\b/, `<svg viewBox="0 0 ${wm[1]} ${hm[1]}"`)
  }
  if (keepColor) return svg.trim()
  svg = svg.replace(/fill="(?!none)[^"]*"/gi, 'fill="currentColor"')
  svg = svg.replace(/stroke="(?!none)[^"]*"/gi, 'stroke="currentColor"')
  // 根节点注入 fill=currentColor：path 未写 fill 属性时 SVG 默认填黑（深色主题下看不见），继承后随文字色
  svg = svg.replace(/<svg\b/, '<svg fill="currentColor"')
  return svg.trim()
}

export const ICONS: Record<string, string> = {}
/** 原色版本：保留 SVG 自带配色（不做 currentColor 归一化），如 agent 品牌机器人 */
export const ICONS_RAW: Record<string, string> = {}
for (const [path, raw] of Object.entries(modules)) {
  const file = path.split('/').pop() ?? ''
  const name = file.replace(/\.svg$/i, '')
  if (name) {
    ICONS[name] = normalize(raw)
    ICONS_RAW[name] = normalize(raw, true)
  }
}

export function Icon({
  name,
  size = 16,
  className = '',
  style,
  raw = false,
}: {
  name: string
  /** 像素边长（图标为方形） */
  size?: number
  className?: string
  style?: CSSProperties
  /** 保留 SVG 原始配色（不跟随文字颜色） */
  raw?: boolean
}): React.JSX.Element {
  const body = raw ? ICONS_RAW[name] : ICONS[name]
  if (!body) {
    console.warn(`[icon] 缺少图标文件: assets/icons/${name}.svg`)
    return (
      <span
        className={`icon icon-missing ${className}`}
        style={{ ...style, width: size, height: size }}
        title={`缺少图标 ${name}`}
      />
    )
  }
  return (
    <span
      className={`icon ${className}`}
      style={{ ...style, width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}
