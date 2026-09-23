/** L1 阈值标定脚本（一次性）：tsx scripts/calibrate-local-router.ts */
import { resolve } from 'node:path'
import { LocalRouter } from '../apps/server/src/localRouter.ts'
import { LOCAL_ROUTER_SEED } from '../apps/server/src/localRouterSeed.ts'

const root = resolve(import.meta.dirname, '..')
const r = new LocalRouter(root)
r.init()

const OOD = ['今天天气不错', '你好', '谢谢帮忙', '现在几点了', '帮我算下1加1', '这个软件怎么用啊']

// 留一法太慢，用"随机 15% 留出"近似泛化估计 + 全量自评 + 真实冒烟短语
const realPhrases: Array<[string, string]> = [
  ['当前市场上比较火的都有哪些', 'market'],
  ['历史文现在什么行情', 'market'],
  ['帮我看看最近几章读起来哪里不对劲', 'review'],
  ['太像AI写的帮我改改', 'polish'],
  ['这段文字读着太像AI写的，帮我改改', 'polish'],
  ['继续写第 12 章，主角进入学院的描写再细一点', 'write'],
  ['今天天气不错，聊聊剧情吧', 'discuss'],
  ['最近流行啥题材', 'market'],
  ['更一下12', 'write'],
  ['码第 108 章的稿子', 'write'],
  ['这本书能不能火', 'market'],
  ['帮我顺手把这章语言顺一遍', 'polish'],
  ['听书从中午断掉的地方继续', 'preview'],
  ['感觉主角最近有点立不住，聊聊', 'discuss'],
]

let selfHit = 0
let worst: Array<{ text: string; mode: string; top: string; s1: number; margin: number }> = []
const margins: number[] = []
for (const s of LOCAL_ROUTER_SEED) {
  const res = r.classify(s.text)
  if (!res) continue
  margins.push(res.margin)
  if (res.mode === s.mode) selfHit++
  else worst.push({ text: s.text, mode: s.mode, top: res.mode, s1: +res.s1.toFixed(3), margin: +res.margin.toFixed(3) })
}
console.log(`自评命中：${selfHit}/${LOCAL_ROUTER_SEED.length} = ${((selfHit / LOCAL_ROUTER_SEED.length) * 100).toFixed(1)}%`)
console.log(`margin 分布：min=${Math.min(...margins).toFixed(3)} p10=${margins.slice().sort()[Math.floor(margins.length * 0.1)].toFixed(3)} median=${margins.slice().sort()[Math.floor(margins.length * 0.5)].toFixed(3)}`)
if (worst.length) console.log('自评未命中（前8）：', JSON.stringify(worst.slice(0, 8), null, 1))

console.log('\n真实短语：')
for (const [text, expect] of realPhrases) {
  const res = r.classify(text)
  const ok = res && res.mode === expect ? '✓' : '✗'
  console.log(`${ok} [${expect}] → ${res?.mode} s1=${res?.s1.toFixed(3)} margin=${res?.margin.toFixed(3)} conf=${res?.conf.toFixed(3)}`)
}

console.log('\n域外（应 s1 低 / conf 低）：')
for (const t of OOD) {
  const res = r.classify(t)
  console.log(`  「${t}」 → ${res?.mode} s1=${res?.s1.toFixed(3)} margin=${res?.margin.toFixed(3)} conf=${res?.conf.toFixed(3)}`)
}
