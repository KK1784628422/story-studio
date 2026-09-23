/**
 * 词级 diff 视图（diff-match-patch + 语义清理）：
 * 等同段落超长时折叠为「…（N 字相同）…」，改动处红删绿增。
 * 用于：审批卡片（改写既有文件预览）/ 导入向导（原文 vs 落盘稿）/ 编辑器历史对比。
 */
import { useMemo } from 'react'
import DiffMatchPatch from 'diff-match-patch'

const EQUAL_EDGE = 24
const EQUAL_KEEP = 72

interface Segment {
  kind: 'equal' | 'insert' | 'delete'
  text: string
}

/** 等同长段折叠：保留前后各 ~24 字，中间以计数标记 */
function collapseEqual(segs: Segment[]): Segment[] {
  return segs.map((s) => {
    if (s.kind !== 'equal' || s.text.length <= EQUAL_KEEP) return s
    const head = s.text.slice(0, EQUAL_EDGE)
    const tail = s.text.slice(-EQUAL_EDGE)
    const omitted = s.text.length - head.length - tail.length
    return { kind: 'equal', text: `${head}\n……（${omitted} 字未变）……\n${tail}` }
  })
}

function computeDiff(oldText: string, newText: string): Segment[] {
  const dmp = new DiffMatchPatch()
  const diffs = dmp.diff_main(oldText, newText)
  dmp.diff_cleanupSemantic(diffs)
  return diffs.map(([op, text]) => ({
    kind: op === 0 ? 'equal' : op === 1 ? 'insert' : 'delete',
    text,
  }))
}

export interface DiffStats {
  added: number
  removed: number
}

export function DiffView({
  oldText,
  newText,
  onStats,
  maxHeight,
}: {
  oldText: string
  newText: string
  onStats?: (stats: DiffStats) => void
  maxHeight?: number
}): React.JSX.Element {
  const segments = useMemo(() => {
    const segs = collapseEqual(computeDiff(oldText, newText))
    if (onStats) {
      let added = 0
      let removed = 0
      for (const s of computeDiff(oldText, newText)) {
        if (s.kind === 'insert') added += s.text.length
        else if (s.kind === 'delete') removed += s.text.length
      }
      onStats({ added, removed })
    }
    return segs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldText, newText])

  const style = maxHeight ? ({ maxHeight, overflowY: 'auto' } as React.CSSProperties) : undefined

  return (
    <div className="diff-view" style={style}>
      {segments.map((s, i) =>
        s.kind === 'equal' ? (
          <span key={i} className="diff-eq">
            {s.text}
          </span>
        ) : (
          <span key={i} className={`diff-${s.kind === 'insert' ? 'ins' : 'del'}`}>
            {s.text}
          </span>
        ),
      )}
    </div>
  )
}
