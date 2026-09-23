/**
 * 桌宠素材转换管线：把用户提供的透明底 PNG（统一 2048×2048）压成 webp 并按
 * 语义命名落入 apps/web/src/assets/pet/，供 PetMascot 叠图交叉淡入使用。
 *
 * 用法：node scripts/convert-pet-assets.mjs [源目录]
 *   源目录默认 <仓库根>/../宠物素材；以后补充新姿势图后重跑本脚本即可，
 *   只需在下方 MAPPING 里加一行中文名 → 目标名。
 */
import { mkdir, readdir, stat, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(process.argv[2] ?? resolve(repoRoot, '../宠物素材'))
const outDir = join(repoRoot, 'apps/web/src/assets/pet')

/** 中文名（可省扩展名）→ 语义化输出名；显示尺寸仅 54~64px，512px 足够 3x 屏 */
const MAPPING = {
  '原型': 'pet-idle',
  '闭眼': 'pet-idle-blink',
  '思考': 'pet-think',
  '工作中埋头打字': 'pet-work',
  '无事可做': 'pet-wait',
  '提问': 'pet-ask',
  '等待用户确认': 'pet-approve',
  '成功': 'pet-happy',
  '失败': 'pet-sad',
  '休眠 (1)': 'pet-stopped',
  '休眠': 'pet-stopped',
}

const fmtKB = (n) => `${(n / 1024).toFixed(0)}KB`

if (!existsSync(srcDir)) {
  console.error(`源目录不存在：${srcDir}`)
  process.exit(1)
}
const files = await readdir(srcDir)
await mkdir(outDir, { recursive: true })

let totalIn = 0
let totalOut = 0
for (const [zh, out] of Object.entries(MAPPING)) {
  const png = files.find((f) => (f === `${zh}.png` || f === `${zh}.PNG`) && !f.startsWith('.'))
  if (!png) {
    console.warn(`  跳过（源缺失）：${zh}.png → ${out}.webp`)
    continue
  }
  const inPath = join(srcDir, png)
  const outPath = join(outDir, `${out}.webp`)
  const inSize = (await stat(inPath)).size
  const info = await sharp(inPath)
    .resize(512, 512, { fit: 'inside' }) // 源已是方形，等比缩到 512，保留 alpha
    .webp({ quality: 82, alphaQuality: 90 })
    .toFile(outPath)
  totalIn += inSize
  totalOut += info.size
  console.log(`  ${png} → ${out}.webp  ${fmtKB(inSize)} → ${fmtKB(info.size)}`)
}
console.log(`合计：${fmtKB(totalIn)} → ${fmtKB(totalOut)}（输出目录 ${outDir}）`)
