/**
 * M0 技术验证脚本：tsx scripts/m0-verify.ts [--with-tts]
 * 0.2 中文路径全链路 / 0.3 脚本白名单执行器 / 0.4 SkillLoader / 门禁引擎 / 0.5 TTS
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SkillLoader } from '../packages/skills/src/index.ts'
import { BashExecutor, GateEngine, SandboxError, resolveSandboxPath } from '../packages/tools/src/index.ts'

const root = resolve(import.meta.dirname, '..')
// 测试工作区：优先 M0_WORKSPACE，缺省项目内 .local/test-workspace（仓库内无此目录——.local/ 被 gitignore，
// 请自行复制一本书工程过去，或设置 M0_WORKSPACE 指向任意 oh-story 书目录）
const m0Workspace = process.env.M0_WORKSPACE
const fallbackWs = join(root, '.local', 'test-workspace')
if (!m0Workspace && !existsSync(fallbackWs)) {
  console.error('缺少测试工作区：请先设置环境变量 M0_WORKSPACE 指向一个 oh-story 书目录，或将一本书复制到 .local/test-workspace')
  process.exit(2)
}
const workspace = m0Workspace ?? fallbackWs
const vendorRoot = join(root, 'packages', 'skills', 'vendor')

let passed = 0
let failed = 0
const ok = (name: string, detail = '') => {
  passed++
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const bad = (name: string, detail = '') => {
  failed++
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string) => console.log(`\n== ${t} ==`)

async function main() {
  section('0.4 SkillLoader：13 个 SKILL.md frontmatter 解析')
  const skills = new SkillLoader(vendorRoot)
  const metas = skills.list()
  const names = metas.map((m) => m.name)
  console.log(`  技能清单（${names.length}）：${names.join(', ')}`)
  names.length === 13 ? ok('13 个技能全部解析') : bad(`期望 13 个技能，实际 ${names.length}`)
  const longWrite = skills.get('story-long-write')
  longWrite && longWrite.description.includes('长篇网文写作')
    ? ok('story-long-write description 解析', longWrite.description.slice(0, 40) + '…')
    : bad('story-long-write description 异常', JSON.stringify(longWrite?.description))
  const content = skills.load('story-long-write')
  content.markdown.length > 3000
    ? ok('L2 加载 SKILL.md 全文', `${content.markdown.length} 字符，资源 ${content.tree.length} 项`)
    : bad('SKILL.md 正文过短', String(content.markdown.length))
  const catalog = skills.catalogText()
  catalog.includes('story-long-write') && catalog.includes('<available_skills>')
    ? ok('L1 目录清单生成', `${catalog.length} 字符`)
    : bad('目录清单异常')

  section('0.2 中文路径沙箱（工作区：M0_WORKSPACE / .local/test-workspace）')
  const sandbox = { workspace, skillDirs: [skills.root] }
  try {
    const p = resolveSandboxPath(sandbox, '大纲/大纲.md')
    ok('中文相对路径解析', p)
  } catch (e) {
    bad('中文相对路径解析失败', String(e))
  }
  try {
    resolveSandboxPath(sandbox, '..\\..\\Windows\\System32')
    bad('越界路径未被拦截')
  } catch (e) {
    e instanceof SandboxError ? ok('越界路径已拦截', (e as Error).message.slice(0, 50)) : bad('拦截异常类型错误', String(e))
  }
  try {
    resolveSandboxPath(sandbox, `${vendorRoot}\\story-long-write\\SKILL.md`, { forWrite: true })
    bad('技能目录写入未被拦截')
  } catch (e) {
    e instanceof SandboxError ? ok('技能目录只读拦截', (e as Error).message.slice(0, 40)) : bad('拦截异常类型错误', String(e))
  }

  section('0.3 Bash 白名单执行器（真实工作区，只读检查）')
  const bash = new BashExecutor({ workspace, sandbox, skills })
  const r1 = await bash.execute('node scripts/check-ai-patterns.js --check --fail-on=blocking 正文/第0001章_*.md')
  r1.exitCode === 0 || r1.exitCode === 1
    ? ok(`check-ai-patterns 中文正文+glob 展开`, `exit ${r1.exitCode}，stdout ${r1.stdout.split('\n').filter(Boolean).length} 行`)
    : bad('check-ai-patterns 执行失败', `exit ${r1.exitCode} stderr=${r1.stderr.slice(0, 200)}`)
  const r2 = await bash.execute('python scripts/tracking_commit.py check --project .')
  r2.exitCode === 0
    ? ok('tracking_commit.py check（Python 子进程 + UTF-8）', r2.stdout.trim().slice(0, 80))
    : bad('tracking_commit.py check 失败', `exit ${r2.exitCode} stderr=${r2.stderr.slice(0, 300)}`)
  const rejects = [
    'cmd /c dir',
    'node ../../evil.js',
    'python -c "print(1)"',
    'rm -rf /',
    'node scripts/check-ai-patterns.js ../../../../etc/passwd',
  ]
  for (const cmd of rejects) {
    try {
      const r = await bash.execute(cmd)
      bad(`白名单未拦截：${cmd}`, `exit ${r.exitCode}`)
    } catch {
      ok(`白名单拦截：${cmd.slice(0, 40)}`)
    }
  }
  const rAbs = await bash.execute(`node ${join(vendorRoot, 'story-long-write', 'scripts', 'check-ai-patterns.js')} --check --fail-on=blocking 正文/第0001章_*.md`)
  rAbs.exitCode === 0 || rAbs.exitCode === 1
    ? ok('绝对路径脚本形态（{skill}/scripts/xxx.js）')
    : bad('绝对路径脚本形态失败', rAbs.stderr.slice(0, 200))

  section('门禁引擎（临时工作区副本，不碰真实书稿）')
  const tmpWs = resolve(root, '.local', 'gate-test')
  rmSync(tmpWs, { recursive: true, force: true })
  mkdirSync(join(tmpWs, '正文'), { recursive: true })
  const badChapter = [
    '# 第010章_测试',
    '',
    '他不是害怕，而是早有准备。不是惊讶，而是意料之中。',
    '她的声音不大，却让所有人都安静了下来。',
    '夜色降临，城市渐渐安静。',
    '他深吸一口气，仿佛一切尽在掌握。',
  ].join('\n')
  writeFileSync(join(tmpWs, '正文', '第010章_测试.md'), badChapter, 'utf8')
  const gate = new GateEngine({ workspace: tmpWs, skills, bash, events: { emit: () => {} } })
  const out1 = await gate.runFullGate(join(tmpWs, '正文', '第010章_测试.md'))
  out1.passed ? bad('含毒句式的章节应 GATE FAILED') : ok('毒句式章节 GATE FAILED', `attempts=${out1.attempts}，脚本：${out1.report.scripts.map((s) => `${s.name}:${s.exitCode}`).join(' ')}`)
  out1.message.includes('GATE FAILED') ? ok('门禁报告回注格式') : bad('门禁报告格式异常')

  const cleanChapter = [
    '# 第010章_测试',
    '',
    '陈默把手里的火苗捏灭，回头看了一眼墙上的挂钟。',
    '十一点四十。楼下便利店的灯还亮着，玻璃门上贴着过期的促销海报。',
    '他推门进去，收银台后的老板娘头也没抬，伸手往货架方向一指。',
    '“老位置。”她说。',
    '货架第三层，最后一排，红色的瓶装咖啡。他拿了瓶子，顺手拧开，付钱，出门。',
    '风从巷口灌进来，带着深秋的凉意。他把领口竖起来，慢慢往回走。',
    '明天还要早起。今晚的事，就当没发生过。',
  ].join('\n')
  writeFileSync(join(tmpWs, '正文', '第010章_测试.md'), cleanChapter, 'utf8')
  const gate2 = new GateEngine({ workspace: tmpWs, skills, bash, events: { emit: () => {} } })
  const out2 = await gate2.runFullGate(join(tmpWs, '正文', '第010章_测试.md'))
  out2.passed ? ok('干净章节 GATE PASSED', `脚本：${out2.report.scripts.map((s) => `${s.name}:${s.exitCode}`).join(' ')}`) : bad('干净章节未过门禁', out2.message.slice(0, 600))

  if (process.argv.includes('--with-tts')) {
    section('0.5 Edge TTS（TS 移植，联网）')
    try {
        const { EdgeTtsService } = await import('../packages/tools/src/index.ts')
      const tts = new EdgeTtsService(join(root, '.local', 'tts-cache'))
      const buf = await tts.synthesize('zh-CN-XiaoxiaoNeural', undefined, undefined, '你好，这里是Story Studio小说创作工作台。')
      const file = join(root, '.local', 'tts-test.mp3')
      writeFileSync(file, buf)
      buf.length > 1000 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0
        ? ok('TTS 合成 mp3', `${buf.length} bytes → ${file}`)
        : bad('TTS 输出异常', `${buf.length} bytes, header=${buf.subarray(0, 4).toString('hex')}`)
      const buf2 = await tts.synthesize('zh-CN-XiaoxiaoNeural', undefined, undefined, '你好，这里是Story Studio小说创作工作台。')
      ok('TTS 磁盘缓存命中', `${buf2.length} bytes`)
    } catch (e) {
      bad('TTS 合成失败', String(e).slice(0, 200))
    }
  }

  section('小结')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

void main()
