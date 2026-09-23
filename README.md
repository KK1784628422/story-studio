# Story Studio

**本地优先的 AI 长篇小说创作工作台**（Electron 桌面 + 纯 Web 双形态）。

它不是"套壳聊天"——真正的价值在于把**网文创作方法论硬化成代码强制执行的流水线**：
写正文必须过 4 道质检脚本门禁，过了门禁还要提交一致性追踪事务，才算一章完成。
约定不靠提示词求模型自觉，而是框架级强制。

- 全部数据在本地：服务只绑 `127.0.0.1`，零公网暴露，书稿不会离开你的磁盘。
- 模型可接任意 OpenAI 兼容端点（DeepSeek / Kimi / GLM / Qwen / 各类网关），BYOK。
- 质检、门禁、追踪都在本地跑脚本，不调用外部服务。

> 约 2.8 万行 TypeScript + 1.5 万行手写 CSS，9 个创作模式、21 个 Agent 工具、20 个技能。

---

## 核心思路

长篇小说最难的从来不是"写一段好文字"，而是**在几十万字之后仍然不崩**：设定不前后矛盾、
伏笔有回收、人物状态连续、文风不飘。Story Studio 的答案是把长篇连载的工程问题变成可执行代码：

| 问题 | 机制 |
|---|---|
| AI 味、复读、细纲照搬 | **质量门禁**：写正文自动快照 + 跑 4 个检测脚本，blocking 未清零不得汇报完成 |
| 人物/伏笔/时间线断线 | **一致性追踪**：四类状态事务化提交，派生视图原子渲染 |
| 越权改稿 | **模式 + 审批**：审稿模式根本没有 Write/Edit 工具；导入/优化模式改写必停靠审批 |
| 上下文成本 | **技能三级披露**：启动只注入技能目录，命中才读全文，脚本按需执行 |
| 长篇工作流迷失 | **7 步同人 / 13 步单章流程**，进度落盘断点续传 |

---

## 功能一览

**9 个模式**（每个模式 = 提示词片段 + 技能子集 + 工具白名单 + 审批策略）：

| 模式 | 用途 | 写入审批 |
|---|---|---|
| 讨论 discuss | 新书讨论、剧情大纲、设定优化 | 一律审批 |
| 创作 write | 正文创作主工作流（13 步单章闭环） | 无（门禁兜底） |
| 导入 import | 外部草稿 → 本工作区一章 | 改写必审批，新建放行 |
| 优化 polish | 去 AI 味 / 文笔升华 / 大修 | 改写必审批 |
| 审稿 review | 4 视角并行只读审稿，产出 S1–S4 分级报告 | 只读，无写入工具 |
| 市场 market | 扫榜 / 拆文（起点 / 番茄 / 七猫 / 晋江等） | 无 |
| 预览 preview | 手机仿真阅读器 / 听书 | 只读 |
| 同人 fanfic | 基于原著的 4 步衍生创作（设定→拆书→卷纲细纲→写作） | 改写必审批 |
| 校准 calibrate | 跨文件矛盾诊断与滞后内容修复 | 改写必审批 |

**写作之外**：手机仿真阅读器（自研分页 + Edge TTS 逐句高亮听书）、人物关系网图谱、
执行画布（节点实时生长）、桌宠状态机、Markdown 富文本编辑、音乐播放器、Token 用量统计。

---

## 架构

pnpm monorepo，依赖方向单向：`web/server` → `agent-core` → `tools/skills` → `shared`。

```
apps/
  server/        Fastify 5 + ws 事件总线（SSE 聊天流 / 文件监听 / 门禁事件推送）
  web/           React 18 + Vite，无 UI 框架、手写 CSS（47 个分区样式文件）
  desktop/       Electron 壳：内嵌 server + 内嵌「Agent 浏览器」（CDP 可视化）
packages/
  agent-core/    Agent 运行时（AI SDK 7）：模式即时生效、审批停靠、流式规范化、网关适配
  tools/         21 个工具：文件读写、质量门禁引擎、追踪事务、技能加载、扫榜、网页 AI
  skills/        技能加载器（三级披露）
    vendor/      来自 oh-story-claudecode 的 13 个技能（MIT，见下方署名）
    local/       本项目自有的 7 个技能（同人、校准、头像生成等）
  preview-core/  预览 / 追踪 / 资料库
  shared/        前后端共享的领域类型
```

**Agent 内核**用 [AI SDK 7](https://sdk.vercel.ai/) 的 `ToolLoopAgent` + `createAgentUIStreamResponse`，
原生流式 + 工具审批停靠 + UIMessage 持久化。模型接入走 `@ai-sdk/deepseek`，
`baseURL` 可指向任意 OpenAI 兼容网关。

---

## 快速开始

### 环境要求

- Node.js **>= 22**
- pnpm（`npm i -g pnpm`）

### 安装与运行

```bash
git clone <this-repo> && cd story-studio
pnpm install

cp .env.example .env    # 填入你的 API key 与端点
pnpm build              # 构建前端
pnpm dev                # 启动服务 → http://127.0.0.1:8100
```

启动后浏览器会自动打开**欢迎页**，先在页面上选择（或新建）一个「书工作区」目录再进入。

开发前端时用两个终端：

```bash
pnpm dev        # 终端 1：后端（8100）
pnpm dev:web    # 终端 2：Vite HMR（5173）
```

### 桌面模式（Electron）

```bash
pnpm dev:desktop
```

桌面模式的额外能力：内嵌「Agent 浏览器」面板（扫榜 / 网页 AI 生图在应用内可视化跑，
**绝不动你的系统浏览器**）、音乐播放器悬浮置顶、无边框标题栏。

### 配置（`.env`）

> 🔑 **本项目不附带任何 API key、账号或凭据。** 所有模型密钥、音乐平台登录态、
> 网页 AI 站点账号一律由使用者自备；仓库内不含作者的任何配置。
> 未配置 key 时服务能启动，但发消息会提示你去配置。

| 变量 | 说明 |
|---|---|
| `STORY_STUDIO_MODEL_BASE_URL` | OpenAI 兼容端点，如 `https://api.deepseek.com/v1` |
| `STORY_STUDIO_API_KEY` | **你自己的** API key |
| `STORY_STUDIO_MODEL_ID` | 模型 ID |
| `STORY_STUDIO_MODELS` | 输入栏可选模型（逗号分隔，第一个为默认） |
| `STORY_STUDIO_WORKSPACE` | 书工作区目录（留空则启动后在欢迎页选择） |
| `STORY_STUDIO_PORT` | 服务端口，默认 `8100` |
| `STORY_STUDIO_AUTO_OPEN` | 是否自动打开浏览器 |

也可以在应用内的**模型设置**面板里配置多个 Provider（含上下文窗口 / 输出上限 /
采样参数 / 图片输入开关），配置存在 `.local/settings.json`（已被 gitignore）。

`.env` 与 `.local/` 都已加入 `.gitignore`，**不要提交**。

📖 **完整上手流程见 [使用教程](docs/使用教程.md)** —— 从装好到写完第一章的逐步指引。

---

## 技能包

技能是这套工作台的方法论载体。运行时会加载两个目录：

- `packages/skills/vendor/` —— 来自 [zenstory-ai/oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode)
  的 13 个技能（长篇/短篇的扫榜、拆文、写作、去 AI 味、封面、导入、审稿、路由）。
  这部分以 **MIT** 许可分发，版权归原作者，原始许可证见
  [`packages/skills/vendor/LICENSE`](packages/skills/vendor/LICENSE)。
- `packages/skills/local/` —— 本项目自有的 7 个技能（同人衍生的拆书与编排、创作校准、
  网页 AI 头像生成流水线）。同名时 **local 覆盖 vendor**。

从上游重新同步 vendor：

```bash
pnpm sync-skills                                          # 默认读 ../oh-story-claudecode/.agents/skills
STORY_STUDIO_SKILLS_SOURCE=/path/to/skills pnpm sync-skills   # 或指定源
```

> ⚠️ `sync-skills` 是 **rm 全删重建**。vendor 已纳入版本控制，运行前请确认
> `git status` 干净，否则本地对 vendor 的改动会被抹掉。

---

## 书工作区结构

一本书就是一个目录（与 oh-story 规范兼容）：

```
你的书目录/
  正文/          第NNN章_标题.md        ← 写这里会自动触发质量门禁
  大纲/          总纲 / 卷纲_第x卷 / 细纲_第NNN章
  设定/          角色-xxx.md / 关系.md（关系总览表驱动前端关系网）
  追踪/          四类一致性状态 + 派生视图（受保护，禁手改）
  原著/          同人模式的原文、拆书产物、进度文件
  .story-studio/ 快照历史 / 报告 / 临时稿 / 审批指纹
```

**质量门禁**在 `正文/*.md` 被写入时触发：

```
快照（保留最近 5 版）→ 标点归一（唯一允许改写文件的脚本）
  → check-ai-patterns / check-outline-copy / check-degeneration 三个只读检测并行
  → 全 exit 0 才 PASSED；任一 blocking → 报告回注 Agent 定点修复 → 复检（上限 3 次）
```

细纲走轻量门禁（只跑退化检测）。作者手动确认过的版本可登记免检，内容一变自动恢复门禁。

---

## 安全说明

- HTTP 服务只绑 `127.0.0.1`，不监听公网；书稿与 API key 都只留在本地。
- API key 存在 `.env` 与 `.local/settings.json`（均被 gitignore）。**分享目录前请确认**。
- Bash 工具是白名单执行器：只放行技能 `scripts/` 目录内的 `node` / `python` 脚本，路径穿越直接拒绝。
- 网页 AI（通道 B）返回的内容标记为 UNTRUSTED，必须评估精修 + 过门禁 + 审批后才可落盘。

---

## 已知限制

- **无自动化测试**。当前验证靠 `scripts/` 下的手动脚本（`pnpm exec tsx scripts/m0-verify.ts` 等）。
  门禁引擎、Bash 沙箱、会话消息清洗这三处最需要回归保护。
- 扫榜类功能依赖目标站点页面结构，受反爬影响，可能随时失效。
- 网页 AI 通道目前适配 GLM / Qwen 站点，新增站点需在 `packages/tools/src/askai/sites/` 加适配器。

---

## 许可

本项目自有代码以 **MIT** 许可发布，见 [`LICENSE`](LICENSE)。
`packages/skills/vendor/` 下的技能包来自 oh-story-claudecode，同样为 MIT，
版权归其原作者，许可证原文见该目录内的 `LICENSE`。
