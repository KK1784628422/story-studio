# 进度协议：原著/_progress.json（常驻参考）

唯一进度权威文件，schemaVersion 2（四步制）。**Agent 与同人面板接口是双写者**（分工见下），每次状态变更立即回写——这是跨会话断点续传的依据。

## Schema

```json
{
  "schemaVersion": 2,
  "meta": { "title": "", "author": "", "totalChars": 0, "updatedAt": "YYYY-MM-DD HH:mm:ss" },
  "step": 1,
  "steps": {
    "s1": { "status": "pending", "substep": "source" },
    "s2": { "status": "pending", "volumes": [
      { "id": 1, "label": "第一卷", "source": "原著/原文/第一卷.txt", "chapters": 0, "summarized": 0,
        "status": "pending", "timelineThrough": "" }
    ]},
    "s3": { "status": "pending", "ficVolumes": [
      { "id": 1, "name": "第一卷标题", "chapters": 45, "sourceVolumes": [1], "confirmedChapters": [1,2,3] }
    ] },
    "s4": { "status": "pending" }
  }
}
```

## 步骤与双写者分工

四步：1 设定（原著+专属）→ 2 拆书 → 3 卷纲与细纲 → 4 创作。

| 写者 | 负责 |
|------|------|
| **Agent** | 检索/拆书/写全部产物文件；s1.substep 与各 steps.sX.status；volumes[].chapters/summarized/timelineThrough/label；s3.volume/total/status；s4.status；step 步进（完成产出后） |
| **面板接口** | volumes[].status=confirmed（用户点「确认本卷拆书」）；step 推进（confirm/advance 接口，带前置守卫）；s3.ficVolumes 登记（拆书页「新建卷纲」弹窗：本书卷名/预计章节数/对应原著卷）与 confirmedChapters 增删（用户逐章勾选确认细纲）；volumes[].forkEvent 同人分岔点（用户在卷详情「时间线」页签点选，event 空 = 清除）；上传时登记新卷/覆盖未拆书卷 |

## 字段语义

| 字段 | 语义 | 写入时机 |
|------|------|---------|
| step | 当前进行到第几步（1-4） | 每步完成时步进（Agent 或面板推进接口） |
| steps.s1.substep | 第 1 步子阶段：`source`（原著设定）/ `own`（专属设定） | 原著设定确认落盘后置 own；进入第 2 步后不再使用 |
| steps.sX.status | `pending` / `in_progress` / `awaiting_confirm` / `done` | 状态迁移即时写；**拆书期间 s2 置 in_progress，卷确认后仍保持 in_progress（多卷循环），全部卷完成才 done** |
| volumes[].chapters | 本卷总章数 | split-source.js 切片后回填 |
| volumes[].summarized | 已摘要章数（**展示用冗余值**） | 不实时维护——摘要文件存在即真值，面板从磁盘派生；每卷聚合完成后顺手对齐一次即可 |
| volumes[].status | `pending` / `in_progress` / `confirmed` | 切片后 in_progress；用户确认后 confirmed（**多为面板接口写入，Agent 不要改回**） |
| volumes[].timelineThrough | 本卷时间线覆盖（如「〈原著历法时间〉 → 〈原著历法时间·后段〉」） | 卷聚合时写入；**时间线溢出判定基准** |
| volumes[].forkEvent | 同人分岔点（原著时间线上某事件文本） | 面板接口写（用户拆书后在卷详情点选，可清除）；**Agent 只读**——第 3 步卷纲据此展开同人轨 |
| steps.s3.ficVolumes | **本书卷清单**（同人的分卷）：id=本书卷号、name=卷名、chapters=预计章节数、sourceVolumes=对应原著拆书卷（可多选）、dir=卷目录（大纲/第{id}卷_{卷名}，本卷卷纲与细纲都写这里）、confirmedChapters=已确认完善的细纲章号 | 面板「新建卷纲」弹窗登记（id 自增，目录已创建）；confirmedChapters 由面板逐章确认接口增删——**Agent 只读，不要改写**；Agent 写产物时用 dir 定位目录 |
| meta.updatedAt | 最后更新时间 | 每次回写时刷新 |

分岔点真值在 volumes[].forkEvent（拆书后即可在面板选择，早于对比文件生成）；做卷纲/细纲时必须遵循：分岔事件之后的同人剧情从 forkEvent 展开，对比表中分岔处的同人轨事件文本含「分岔点」三字（面板据此高亮）。

## v1 → v2 迁移（旧七步文件）

旧 v1（schemaVersion 1，step 1-7）首次被服务端读取时自动迁移落盘：v1 step 1/2 → v2 step 1（substep source/own）；3/7 → 2；4/5 → 3；6 → 4。Agent 遇到残留 v1 文件（服务端未触达的边缘情况）也应自行按此映射迁移（读 → 改字段 → schemaVersion 置 2 回写），再继续工作。

## 写入纪律

1. **用 Edit 局部修改**（最小 diff），不要 Write 全量重写——面板接口与 Agent 并发写同一文件，全量重写会覆盖面板刚写入的确认状态；改写既有文件触发审批卡是预期行为（状态变更应让用户看见）；
2. 回写失败（文件被外部改动/JSON 损坏）→ 读取现值重建后重写，并向用户报告差异；
3. **新会话开工**（用户说「继续同人」或任意同人指令）：
   - Read _progress.json → 汇报「当前第 {step} 步：{该步一句话状态}；已完成：{已完成步骤列表}」→ 继续当前步骤（不重做已确认内容）；
   - 注意卷确认与本书卷登记可能由用户在面板完成——volumes[].status=confirmed / s3.ficVolumes 视为既成事实，直接在其基础上继续；
   - _progress.json 不存在但 原著/ 目录有内容 → 提示用户进度文件缺失，问询当前所处步骤后重建骨架；
   - 完全没有 原著/ → 全新开始，从第 1 步问询。

## 会话建议纪律（提示但不强制）

- 第 1 步两个子阶段完成后：各提示一次；
- 第 2 步：每拆完一卷提示；单会话拆满 3 个桥段（一卷约 5 段）强制收尾提示；
- 第 3 步每卷确认后：提示一次；
- 第 4 步（write 模式中）：每写完 2-3 章提示一次；
- 提示话术固定：「建议新开会话以保持上下文清爽，输入『继续同人』即可从断点恢复。」
