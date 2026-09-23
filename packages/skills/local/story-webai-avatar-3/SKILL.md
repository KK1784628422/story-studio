---
name: story-webai-avatar-3
description: "网页 AI 人物头像生成 3.0（三段流水线完整体）：审美筛查（静帧四问）→ Creative Meeting 摄影团队会议 + 七大模块决策（Character DNA 含古典骨相 / Attention / Story Moment / Photography Strategy / Visual Hook / Photographer's Notes / Director's Observation）→ 转译组装（豆包化 MJ 转译：全肯定句骨相 / 明度定位 / 敏感词规避 / 负向融入）→ webai_draw 调豆包生图。触发：3.0头像 / 头像3.0 / 完整流程头像 / 流水线头像 / 网页AI生图3.0。与 1.0 / 2.0 并存供对比。"
---

# story-webai-avatar-3 网页 AI 人物头像生成 3.0（三段流水线完整体）

> 3.0 = 三套摄影 skill 的完整流水线 + 我们的角色卡输入端 + webai_draw 调用：
> ① **审美筛查**（这帧值不值得拍）→ ② **Creative Meeting + 七大模块**（怎么拍，决策全程透明展示）
> → ③ **转译组装**（把剧组语言转译成豆包接得住的指令）。
> 与 2.0 的分野：2.0 是静默决策省 token 版（六步决策不展示）；3.0 是完整体——会议纪要、
> 七大模块产出在聊天里全程展示，且转译层完整吸收硬资产（古典骨相模块 / 明度定位 / 敏感词规避 /
> 第一句独立成图 / 动态事件必有）。

## 触发（严格显式）

- 用户明确要求「3.0 头像 / 头像 3.0 / 完整流程头像 / 流水线头像 / 网页AI生图 3.0」时命中本技能；
- 普通头像请求命中 1.0（story-webai-avatar）；「2.0 / 电影感 / cinematic」命中 2.0（story-webai-avatar-2）。

## 流程（严格按序，不得跳步）

### Step 0 · 确认人物与要求

1. 从用户指令中取**人物名**（必须与 `设定/角色/{人物名}.md` 文件名一致）；
   名下无角色卡时：先从设定与正文提取该人物信息生成角色卡（经用户确认），再继续。
2. 用户给了**风格标签** → 融入审美筛查与最终 Prompt 的 Intent/Rendering 段；
   未给 → 默认「写实电影人像」。

### Step 1 · 读人物卡

用 Read 读取 `设定/角色/{人物名}.md`，提取：基本信息（时代/身份/年龄）、外貌特征、性格关键词、
标志物、处境、人物弧线。缺项从世界观与正文补全，汇报时注明推断项。
**五规则（彩蛋/反差/可视化/色调对位/时代考据）全程生效**，与 2.0 相同。

### Step 2 · 读参考文件

用 Read 读取本技能目录三个参考文件（路径见技能资源块）：

- `references/pipeline.md` — 审美筛查 + Creative Meeting 格式 + 七大模块句式库
- `references/bone-structure.md` — 古典骨相模块（男/女全肯定句库，转译层核心资产）
- `references/assembly.md` — 豆包化转译 + 敏感词规避 + 负向融入 + 三层自检

### Step 3 · 审美筛查（上游放行门）

按 pipeline.md「审美筛查」做**静帧四问**：第一眼好看吗 / 视觉中心自然形成吗 /
只有一种主感受吗 / 删掉剧情画面还成立吗。任一不过 → 换场景重做（不是加特效补救）。
同书多角色时检查美感发动机轮换（上一张靠光，这张就不能再靠光）。
筛查结论一句话汇报：「这一帧主要靠 ______ 成立」。

### Step 4 · Creative Meeting（中文会议纪要，展示给用户）

按 pipeline.md 格式输出摄影团队会议：Director（拍什么主题）/ Cinematographer（镜头·机位·占比）/
Art Director（主色与明度秩序）/ Creative Director（Visual Hook 三眼路径）/ Story（这一秒刚发生什么）。

### Step 5 · 七大模块（英文产出，展示给用户）

按 pipeline.md 七模块逐个产出：Character DNA（原型+反差+**骨相规格**）→ Attention（灵魂模块）→
Story Moment → Photography Strategy（决策清单逐项）→ Visual Hook → Photographer's Notes →
Director's Observation。每模块标注模块名，不得合并跳步。

### Step 6 · 转译组装（豆包化）

按 assembly.md 把七模块产出转译组装成最终英文 Prompt（300-450 词摄影笔记式散文）：
骨相模块全肯定句融入 / 占比具体百分比 + off centre / 明度定位显式 / 第一句独立成图 /
动态事件必有 / 敏感词扫查替换 / 负向压缩 2-4 句融入结尾。
**同步输出中文对照版 + 模块映射表 + 彩蛋清单**（三件套，供用户微调）。

### Step 7 · 三层自检（审美层 / 摄影层 / 转译层）

过 assembly.md 末尾三层自检清单，任一不过打回对应层重做——审美层不过换场景，
摄影层不过改模块，转译层不过改措辞。全过才允许调工具。

### Step 8 · 调 webai_draw（一次调用，不要分步操作浏览器）

```
webai_draw {
  character: "<人物名>",
  prompt: <Step 6 英文主提示词>,
  maxWaitMs: 240000
}
```

### Step 9 · 处理返回

与 2.0 完全一致：`needLogin:true` → 引导登录后同 prompt `reuse:true` 重调；
`ok:true` → 汇报路径 + 中文对照要点；`ok:false` → 超时类等 30s 后 `reuse:true` 重调（同人物总计 ≤3 次），
有 imageUrl 给用户兜底，失败如实告知。

## 硬约束

1. **省 token 纪律**：一次任务只调一次 webai_draw（needLogin/失败后 reuse 重调除外）；禁止用 browser_cdp 手动操作豆包。
2. **不得跳步**：审美筛查未过不进会议；七模块未完成不组装；三层自检未过不调工具。会议纪要与模块产出是交付物的一部分，不得为省篇幅省略。
3. **正向禁用词零命中**（8K / 4K / masterpiece / best quality / ultra detailed / HDR / epic / sharp focus / high resolution / perfect face / flawless / doll face / large eyes / full lips / gentle——完整清单见 assembly.md）。
4. **人物名一致性**：`character` 与角色卡文件名一致。
5. **同作品色调对位 + 美感发动机轮换**：同书多角色先后生成时，检查历史，色盘与发动机都错开。
6. **失败如实告知**；纯 Web 模式提示用桌面端。

## 站点

| site | 站点 | 说明 |
|---|---|---|
| `doubao`（默认） | 豆包 doubao.com | 对话框直接发提示词自动生图；需已登录豆包账号 |
