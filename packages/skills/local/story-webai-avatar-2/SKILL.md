---
name: story-webai-avatar-2
description: "网页 AI 人物头像生成 2.0（电影摄影级）：读角色卡 → 静默摄影决策（Character DNA 原型选型/Attention/Story Moment/Photography Strategy/Visual Hook）→ 摄影笔记式九段英文提示词 → webai_draw 调豆包网页版生图 → 自动下载并配置到 设定/头像/。触发：2.0头像 / 头像2.0 / 电影感头像 / 电影级头像 / 摄影感头像 / cinematic头像 / 网页AI生图2.0。输入端（角色卡+五规则）与 1.0 一致，输出端为电影摄影级（与 1.0 story-webai-avatar 并存，供对比测试）。"
---

# story-webai-avatar-2 网页 AI 人物头像生成 2.0（电影摄影级）

> 2.0 与 1.0（story-webai-avatar）的分野：**输入端完全一致**（读同一张角色卡，五条设计规则全保留），
> **输出端全面重构**——1.0 是七段式描述模板（画面里有什么），2.0 是电影摄影决策
>（为什么这样拍、注意力放哪、决定不拍什么）。Prompt 是摄影师工作笔记（Photographer's Notes），
> 不是物体清单（Object List）。

## 触发（严格显式）

- 用户明确要求「2.0 头像 / 头像 2.0 / 电影感头像 / 电影级头像 / 摄影感头像 / cinematic 头像 / 网页AI生图 2.0」时命中本技能；
- 用户要求生成头像且额外强调「电影感 / 电影级 / 摄影质感 / 像电影剧照 / cinematic」时命中本技能；
- 用户明确要求「3.0 / 完整流程 / 流水线」版本时**不命中本技能**，改用 story-webai-avatar-3（三段流水线完整体，决策全程展示）；
- 普通头像请求（无上述任何关键词）命中 1.0（story-webai-avatar），本技能不抢。

## 流程

### Step 0 · 确认人物与要求

1. 从用户指令中取**人物名**（必须与 `设定/角色/{人物名}.md` 文件名一致——头像按文件名配置）；
   名下无角色卡时：先从设定与正文提取该人物信息生成角色卡（经用户确认），再继续。
2. 用户给了**风格标签**（如 国风插画/动漫风/写实电影风）→ 在 Step 2 生成提示词时把风格融入
   Intent 段（第 1 句定调）与 Rendering Constraints 段；
   未给 → 默认「写实电影人像」（quiet cinematic portrait, real-film feel）。

### Step 1 · 读人物卡

用 Read 读取 `设定/角色/{人物名}.md`，提取：基本信息（时代/身份/年龄）、外貌特征、性格关键词、
标志物、处境、人物弧线。人物卡太薄（缺外貌/标志物）时，从世界观设定与正文出场章节补全，
并在汇报时说明哪些是推断项。

### Step 2 · 生成电影摄影级提示词（2.0 核心）

先用 Read 读取本技能目录下两个参考文件（路径见技能资源块）：

- `references/prompt-template.md` — 2.0 提示词方法论：静默摄影决策六步 + 九段组装 + 禁用词 + 负向融入 + 自检
- `references/archetypes.md` — 人物原型库（Character DNA 底稿，女/男原型各一组）

严格按其流程执行：

1. **静默摄影决策**（六步，决策过程不占用聊天——结果体现在中文对照版与映射表）：
   摄影主题 → Character DNA（原型选型+反差设计）→ Attention → Story Moment → Photography Strategy → Visual Hook；
2. **组装**：九段摄影笔记式英文散文（Intent → Hierarchy → Attention → Photography Strategy →
   Visual Hook → Photographer's Notes → Director's Observation → Scene Details → Rendering Constraints），
   Scene 含五要素，全文 300-450 词；
3. **负向融入**：豆包无独立负向字段 → 按模板把负向压缩成 2-4 句融入正向结尾；
4. **自检**：过模板末尾自检清单（禁用词零命中等十项），任一不过打回重写；
5. **输出三件套**：英文主提示词 + 中文对照版（逐模块对应）+ 模块映射表（含彩蛋清单）——
   中文对照版与映射表在聊天里展示给用户供微调，英文主提示词作为 `webai_draw.prompt`。

### Step 3 · 调 webai_draw（一次调用，不要分步操作浏览器）

```
webai_draw {
  character: "<人物名>",        // 与角色卡文件名一致
  prompt: <Step 2 英文主提示词>,
  maxWaitMs: 240000             // 默认 240s，一般无需调
}
```

工具自动完成：豆包登录判定 → 填提示词 → 发送 → 轮询图片生成 → 下载 → 写
`设定/头像/{人物名}.{png|jpg|webp}` → 广播文件变更（前端头像自动刷新）。全程绿光圈可视化。

### Step 4 · 处理返回

**`needLogin: true`**：工具已亮红光圈提示用户登录。你只需告诉用户「请在 Agent浏览器 面板完成豆包登录」，
登录后用同一 prompt 重调一次 webai_draw，**并传 `reuse: true`**（优先收取登录期间可能已生成的图，不重复发送提示词）。

**`ok: true`（成功）**：向用户汇报——头像已配置到 `{path}`（人物关系网/角色卡已刷新），
附中文对照版要点；提示用户可在资料页关系网点节点查看，右键可换图。

**`ok: false`（失败）**：
- **超时/「连续读取页面状态失败」/通道无响应类错误**：豆包侧任务很可能仍在进行或已完成——
  等 30s 后用同一 prompt **`reuse: true`** 重调一次（工具会保留现场直收已生成的图，不重新生成）；
- 有 `imageUrl`：把图片地址给用户（浏览器打开可手动保存）；
- 发送失败（填入/点击类错误）：如实告知原因（豆包可能改版需重新踩点），稍后可完整重试一次；
- 同一人物总计不超过 3 次调用（含 reuse 重调），仍失败则如实汇报并给 imageUrl 兜底。

## 硬约束

1. **省 token 纪律**：一次任务只调一次 webai_draw（needLogin/失败后 reuse 重调除外）；**禁止**用 browser_cdp
   的 snapshot/click/type/eval 手动操作豆包（那是排障工具，不是生图通道）。
2. **提示词先行 + 自检门**：没做完 Step 2 的六步决策与自检清单不允许调 webai_draw；
   **正向 Prompt 禁用词零命中**（8K / 4K / masterpiece / best quality / ultra detailed / HDR / epic…
   全清单见模板）——这是 2.0 与 1.0 的硬区别，出现任何一个即打回重写再调用。
3. **人物名一致性**：`character` 必须与角色卡文件名一致，否则头像配不到人（关系网按文件名匹配）。
4. **同作品色调对位**：同一本书多个人物先后生成时，检查此前人物的色调（可在聊天历史或角色卡备注），
   按模板规则错开色盘。
5. **失败如实告知**：不编造结果；豆包不可用时说明原因，不承诺「稍后会自动完成」。
6. **纯 Web 模式**：webai_draw 返回需桌面端的错误时，直接告知用户在桌面应用中使用本功能。

## 站点

| site | 站点 | 说明 |
|---|---|---|
| `doubao`（默认） | 豆包 doubao.com | 对话框直接发提示词自动生图；需已登录豆包账号 |

新增生图站点（即梦/Seedream 网页版等）：在 `packages/tools/src/webaidraw/` 加站点常量并注册。
