#!/usr/bin/env node
/**
 * 同步 oh-story 技能包到 packages/skills/vendor/
 * 源：默认 ../oh-story-claudecode/.agents/skills（13 个技能，含 story 路由技能）
 * 可用环境变量 STORY_STUDIO_SKILLS_SOURCE 覆盖源路径。
 * 注意：vendor 为纯同步产物（每次 rm 重建）——story-studio 本地技能放 packages/skills/local/。
 * ⚠ 2026-09 起 vendor 已纳入版本控制（不再 gitignore）：本脚本会 **rm 全删重建**，
 *   运行前请确认 vendor 侧没有领先于源的本地改动（`git status` 应干净），否则改动会被抹掉。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.env.STORY_STUDIO_SKILLS_SOURCE ?? '../oh-story-claudecode/.agents/skills')
const dest = resolve(root, 'packages/skills/vendor')

if (!existsSync(source)) {
  console.error(`[sync-skills] 技能源目录不存在: ${source}`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

const skills = readdirSync(source, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

for (const name of skills) {
  cpSync(resolve(source, name), resolve(dest, name), { recursive: true })
  console.log(`[sync-skills] + ${name}`)
}

// oh-story 脚本是 CommonJS（require）；vendor 最近 package.json 声明 commonjs，
// 覆盖 skills 包的 "type": "module"，使 Node 按 CJS 解析这些 .js 脚本
writeFileSync(resolve(dest, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf8')

// 清单里的 source 存**相对路径**：manifest 会随仓库分发，绝对路径既不可移植也会泄漏本机用户名
writeFileSync(
  resolve(dest, '.vendor-manifest.json'),
  JSON.stringify({ source: relative(root, source), skills, syncedAt: new Date().toISOString() }, null, 2),
  'utf8',
)

console.log(`[sync-skills] 完成：${skills.length} 个技能 → ${dest}`)
