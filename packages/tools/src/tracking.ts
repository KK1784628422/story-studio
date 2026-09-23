/**
 * tracking 工具：封装 tracking_commit.py / storyctl.py 的追踪事务通道。
 * _tracking-state.json 是唯一权威；派生视图禁手改——Agent 更新追踪的唯一通道即此工具。
 *
 * 事实接口（与技能内脚本一致）：
 *   init:   tracking_commit.py init   --project {ws} --input {txn.json}
 *   check:  tracking_commit.py check  --project {ws}
 *   commit: storyctl.py chapter commit --project {ws} --chapter N --input {txn.json}   ← 推荐入口（自动注入 wordcount 并重跑质检）
 *           storyctl.py chapter accept-current-length --project {ws} --chapter N --input {txn.json}
 *           tracking_commit.py commit --project {ws} --input {txn.json}               ← direct（正文修订 revision 等）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import type { ToolContext } from './context.ts'

export function createTrackingTools(ctx: ToolContext): ToolSet {
  const scriptsDir = () => {
    const skill = ctx.skills.get('story-long-write')
    if (!skill) throw new Error('技能 story-long-write 未加载（vendor 同步缺失）')
    return join(skill.dir, 'scripts')
  }

  const writeTxnFile = (payload: unknown): string => {
    const tmpDir = join(ctx.workspace, '.story-studio', 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const file = join(tmpDir, `tracking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    return file
  }

  const emitRevision = (stdout: string) => {
    try {
      const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
      if (typeof parsed?.state_revision === 'number') {
        ctx.events.emit({ type: 'tracking:updated', revision: parsed.state_revision })
      }
    } catch {
      // 输出非 JSON（如 check 模式），忽略
    }
  }

  const trackingTool = tool({
    description:
      '追踪事务（_tracking-state.json 唯一权威，派生视图禁手改）。模式：check=校验当前状态（写前必跑，取 state_revision/last_committed_chapter）；validate=dry-run 校验 payload 契约（不落盘、返回全部字段级结构错误，commit 前先跑可一次修完）；init=初始化（仅 _tracking-state.json 不存在时）；commit=提交逐章事务。mode 可省略：不传且无 payload=check，有 payload=commit（init 必须显式传）。commit 的 entry：chapter=storyctl chapter commit（推荐，自动注入 wordcount 并重跑质检，事务 JSON 禁写 wordcount 字段）；accept-current-length=字数在用户带外但质量过关时；direct=tracking_commit.py commit（正文修订 revision 事务等）。commit 前工具自动预检：质量 blocking 未清零会拦下不提交；字数越界（over/under）但质量通过会自动按 accept-current-length 提交——**无需也不应手动先试 chapter 再换入口重试**。事务 payload 契约：schema_version=1；mode=append|revision（append 必须 chapter=last+1，revision ≤last）；expected_state_revision 必须等于当前 state_revision（构造前先 check）；delta 含 result/character_changes/foreshadow_changes/timeline_events/constraints/next_chapter_commitments/retired_context_items/retired_characters（退役条目漏报会被拒，只能在 append 模式）；context 只收 position/long_term_constraints/active_character_names/continuity_risks 四项；character_snapshots 的角色必须同时出现在 character_changes。',
    inputSchema: z.object({
      mode: z.enum(['check', 'init', 'commit', 'validate']).optional().describe('事务模式（可省略：无 payload=check，有 payload=commit；init/validate 必须显式传）'),
      payload: z.record(z.string(), z.unknown()).optional().describe('init/commit 的事务 JSON 对象'),
      entry: z.enum(['chapter', 'accept-current-length', 'direct']).optional().describe('commit 入口（默认 chapter；字数越界且质量通过时工具自动用 accept-current-length，无需手动指定）'),
      chapter: z.number().int().min(1).optional().describe('章号（entry 非 direct 时必填，默认取 payload.chapter）'),
    }),
    execute: async ({ mode, payload, entry, chapter }) => {
      const dir = scriptsDir()
      const py = await ctx.bash.python
      const ws = ctx.workspace
      // ① schema 推断护栏：check 无 payload、commit 必有 payload，天然可推；漏 mode 不再整份重发
      const effMode = mode ?? (payload ? 'commit' : 'check')

      if (effMode === 'check') {
        const r = await ctx.bash.runProcessRaw(
          py.cmd,
          [...py.args, join(dir, 'tracking_commit.py'), 'check', '--project', ws],
          ws,
          60_000,
        )
        return {
          mode: effMode,
          exitCode: r.exitCode,
          stdout: r.stdout.slice(0, 6000),
          stderr: r.stderr.slice(0, 4000),
          hint:
            r.exitCode === 0
              ? '校验通过。可从 stdout JSON 取 state_revision 与 last_committed_chapter。'
              : '校验失败：按 stderr 报错定位问题（派生视图被手改→用 revision 事务重建；state 损坏→人工处理）。',
        }
      }

      if (!payload || typeof payload !== 'object') {
        throw new Error(`${effMode} 模式必须提供事务 payload（JSON 对象）`)
      }
      const txnFile = writeTxnFile(payload)

      // dry-run 校验：不落盘、不加锁，返回全部字段级错误，commit 前先跑可一次修完
      if (effMode === 'validate') {
        const vr = await ctx.bash.runProcessRaw(
          py.cmd,
          [...py.args, join(dir, 'tracking_commit.py'), 'validate', '--project', ws, '--input', txnFile],
          ws,
          60_000,
        )
        let valid = false
        try {
          valid = (JSON.parse(vr.stdout.trim().split('\n').at(-1) ?? '') as { valid?: boolean })?.valid === true
        } catch {
          valid = false
        }
        return {
          mode: effMode,
          exitCode: vr.exitCode,
          stdout: vr.stdout.slice(0, 6000),
          stderr: vr.stderr.slice(0, 4000),
          hint: valid
            ? 'payload 契约校验通过，可安全 commit。'
            : 'payload 结构/契约错误（已全部列出）：按错误的字段修正后重跑 validate 或直接 commit。',
        }
      }

      let r
      let fallback = false // 是否因字数越界自动降级 accept-current-length（作用域提升到 commit 分支外，供返回 hint 使用）
      if (effMode === 'init') {
        r = await ctx.bash.runProcessRaw(
          py.cmd,
          [...py.args, join(dir, 'tracking_commit.py'), 'init', '--project', ws, '--input', txnFile],
          ws,
          60_000,
        )
      } else {
        const ch = chapter ?? (payload as { chapter?: unknown }).chapter
        if (typeof ch !== 'number') {
          throw new Error('commit 需要章号：传 chapter 参数或确保 payload.chapter 为数字')
        }
        if (entry === 'direct') {
          r = await ctx.bash.runProcessRaw(
            py.cmd,
            [...py.args, join(dir, 'tracking_commit.py'), 'commit', '--project', ws, '--input', txnFile],
            ws,
            60_000,
          )
        } else {
          // ② 提交前自动预检（省整份 payload 重发）：先跑 chapter check 拿字数带/质量结论
          const pre = await ctx.bash.runProcessRaw(
            py.cmd,
            [...py.args, join(dir, 'storyctl.py'), 'chapter', 'check', '--project', ws, '--chapter', String(ch)],
            ws,
            60_000,
          )
          let preChecked: { length?: { status?: string }; quality?: { status?: string }; available_actions?: string[] } | null = null
          try {
            preChecked = JSON.parse(pre.stdout.trim().split('\n').at(-1) ?? '') as {
              length?: { status?: string }
              quality?: { status?: string }
              available_actions?: string[]
            } | null
          } catch {
            preChecked = null
          }
          const lenStatus = preChecked?.length?.status
          const qualityPass = preChecked?.quality?.status === 'pass'
          const outOfBand = lenStatus === 'over' || lenStatus === 'under'
          // 质量未过：拦下不提交，明确告知（质量问题是改稿问题，不应 accept-current-length 绕过）
          if (!qualityPass) {
            return {
              mode: effMode,
              entry: entry ?? 'chapter',
              exitCode: pre.exitCode,
              stdout: pre.stdout.slice(0, 6000),
              stderr: pre.stderr.slice(0, 4000),
              txnFile,
              hint: '预检未通过：质量 blocking 未清零，禁止提交。按 stderr 定位 blocking 修稿后重试；不要用 accept-current-length 绕过质量问题。',
            }
          }
          // 字数越界但质量通过：自动降级 accept-current-length（行为等价于模型失败后手动换入口，但省一次整份重发）
          fallback = outOfBand && entry !== 'accept-current-length'
          const sub = entry === 'accept-current-length' || fallback ? 'accept-current-length' : 'commit'
          r = await ctx.bash.runProcessRaw(
            py.cmd,
            [...py.args, join(dir, 'storyctl.py'), 'chapter', sub, '--project', ws, '--chapter', String(ch), '--input', txnFile],
            ws,
            120_000,
          )
          // ③ 失败 hint 增强：把 storyctl 的 JSON 结论翻成人话，避免模型盲重试
          if (r.exitCode !== 0 && sub === 'accept-current-length') {
            let err: { message?: string } | null = null
            try {
              err = JSON.parse(r.stderr.trim().split('\n').at(-1) ?? '') as { message?: string } | null
            } catch {
              err = null
            }
            const extra = err?.message ? `（${err.message.slice(0, 200)}）` : ''
            r = {
              ...r,
              // 标记到外层 hint 使用
              stderr: `${r.stderr}\nHINT_SUGGESTION: 字数越界且质量通过，本应自动 accept-current-length；若此处仍失败，多为事务 payload 校验问题（stale revision / 字段契约），按上方错误修正 payload 后重试。${extra}`,
            }
          }
        }
      }

      if (r.exitCode === 0) emitRevision(r.stdout)

      const autoFallback = r.exitCode === 0 && fallback === true
      return {
        mode: effMode,
        entry: effMode === 'commit' ? (entry ?? 'chapter') : undefined,
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 6000),
        stderr: r.stderr.slice(0, 4000),
        txnFile,
        hint:
          r.exitCode === 0
            ? autoFallback
              ? '提交成功（字数越界但质量通过，已自动按 accept-current-length 提交，此为预期行为，无需手动重试）。'
              : '提交成功。'
            : '提交失败：事务文件已保留（txnFile）。若 stderr 含 HINT_SUGGESTION 说明已尝试自动降级仍失败，按上方错误修正 payload（stale revision 先 check 取最新 state_revision）后重试。',
      }
    },
  })

  const queryTrackingTool = tool({
    description:
      '只读快捷通道：直读 追踪/ 派生视图。what: chapters=逐章记录清单；characters=角色状态快照清单；foreshadows=伏笔台账；timeline=时间线（作者真相+读者已知）；context=续写状态卡（上下文.md，写前必读）。',
    inputSchema: z.object({
      what: z.enum(['chapters', 'characters', 'foreshadows', 'timeline', 'context']),
    }),
    execute: async ({ what }) => {
      const t = (p: string, cap = 6000) => {
        const abs = join(ctx.workspace, p)
        if (!existsSync(abs)) return `（${p} 不存在）`
        return readFileSync(abs, 'utf8').slice(0, cap)
      }
      const list = (p: string) => {
        const abs = join(ctx.workspace, p)
        if (!existsSync(abs)) return []
        return readdirSync(abs).sort()
      }
      switch (what) {
        case 'chapters':
          return { what, files: list('追踪/逐章记录') }
        case 'characters':
          return { what, files: list('追踪/角色状态') }
        case 'foreshadows':
          return { what, content: t('追踪/伏笔.md') }
        case 'timeline':
          return {
            what,
            authorTruth: t('追踪/时间线/作者真相.md', 4000),
            readerKnown: t('追踪/时间线/读者已知.md', 4000),
          }
        case 'context':
          return { what, content: t('追踪/上下文.md', 10000) }
      }
    },
  })

  return { tracking: trackingTool, query_tracking: queryTrackingTool }
}
