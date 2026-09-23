# 样式目录维护指南（styles/）

> 拆分自原 7400 行 `styles.css`（2026-08-30，按原分区标记机械切割，内容零改动）。
> 拆分前的完整备份：仓库根 `styles-backup-pre-split.css`，确认稳定后可删。

---

## 一、目录结构（38 个模块 + 入口）

**`index.css` 是唯一入口**（`main.tsx` 引用它），只做 @import 登记，**不写任何规则**。

| 文件 | 分区 | 管什么 |
|---|---|---|
| `00-tokens.css` | 设计令牌 | 全部 CSS 变量：色板/字体/圆角/阴影/动效/z 序谱 + `:root` 深色默认值 |
| `01-base.css` | 基础 | reset、html/body、滚动条等全局基础 |
| `02-topbar.css` | 顶栏 | 品牌区、模式徽章、窗口拖拽区（desktop-titlebar） |
| `03-drawers.css` | 抽屉 | 会话列表 / 书架条目 / 日志行（`.session-*` `.log-*`，日志面板内容区也复用） |
| `04-settings-modal.css` | 设置表单 | `ModelSettings` 表单件（`.settings-row/-input/-select/-list`），弹窗外壳已迁 25b |
| `05-layout.css` | 主布局 | `.app` 纵向骨架（顶栏 → 工作区 → 状态栏） |
| `06-chat.css` | 聊天面板 | 消息流、markdown 正文、思考块、回到底部 |
| `07-tool-card.css` | 工具卡片 | Agent 工具调用卡片 |
| `08-composer.css` | 输入区基座 | `.prompt-input` 容器、工具栏、模型/思考选择器、发送/停止钮 |
| `08b-composer-plus.css` | 输入栏扩展 | 「+」菜单、图片附件、@ 引用标签（高亮叠层）、网页AI 胶囊、内联提示 |
| `09-approval.css` | 审批 | 审批卡 / 批量条 / 待决停靠 |
| `10-gate.css` | 门禁 | 红牌停靠卡 |
| `11-question-form.css` | 问答表单 | ask_questions 内嵌表单 + 兜底表单 |
| `12-workspace.css` | 工作区容器 | 拖拽 splitter、嵌入占位 |
| `13-phone-frame.css` | 手机壳 | 预览手机框 |
| `14-reader.css` | 阅读器 | 翻页阅读器正文（纸张底色自成体系，基本不受主题影响） |
| `15-reader-drawer.css` | 阅读器抽屉 | 目录/音色/设置浮层 |
| `16-editor.css` | 章节编辑器 | 编辑面板 |
| `17-cards-docs.css` | 卡墙/文档 | 资料卡墙、文档弹窗、`.markdown` 渲染基底 |
| `18-tracking.css` | 追踪 | 追踪面板 |
| `19-diff.css` | Diff | 词级差异高亮 |
| `20-import.css` | 导入 | 导入向导 |
| `21-report.css` | 报告 | 报告面板 |
| `22-toast.css` | Toast | 全局轻提示 |
| `22b-route-pet.css` | 路由桌宠 | 发送期桌宠条（RoutePendingBot，`.route-pending`/`.rp-*`） |
| `23-welcome.css` | 欢迎页 | 开始创作全屏页 |
| `24-dir-tree.css` | 目录树 | 空间目录选择器 |
| `25-animation.css` | 动画 | 全局 keyframes（`pop-in`/`mask-in`/`rp-*` 等） |
| `26-responsive.css` | 响应式 | 窄屏适配 |
| `27-a11y.css` | 无障碍 | `prefers-reduced-motion` 全局降级 |
| `28-workbench.css` | 工作台四栏 | 活动栏/侧面板/聊天列/可视化列/资源管理器 布局 |
| `29-panel-fn.css` | 可视化一级功能 | 可视化/文档编辑/Agent浏览器 页签、资料/大纲/报告/设定/追踪子页 |
| `28a-browser-agent.css` | 内置浏览器 | Agent 视图（直播页签） |
| `28a2-extension-inject.css` | 扩展注入 | 操作台 |
| `28b-workbench-responsive.css` | 四栏响应式 | 宽窄屏切换规则 |
| `25b-settings-hub.css` | 设置中心外壳 | 统一弹窗（页签导航/滑动指示条/切页动画） |
| `26b-statusbar-logpanel.css` | 状态栏 | 底部状态栏 + 日志面板（面板本体，内容行复用 03 的 `.log-*`） |
| `30-themes.css` | 主题系统 | 全部主题覆盖：`html[data-theme=…]` 变量块 + 硬编码回写 + 主题卡片 |

> **编号即来源分区，不严格等于导入顺序**（历史编号有交错，如 28 系列写在 29 之后）。唯一事实源是 `index.css` 的 import 顺序。

## 二、三条铁律

1. **@import 顺序 = 层叠顺序**。后面的文件覆盖前面的同名规则。新增文件插到 `index.css` 的正确位置（默认放相关分区之后），不要重排现有顺序。
2. **令牌优先**。写新样式先用 `00-tokens.css` 里的变量（`var(--bg-panel)`、`var(--gold)`…），只有语义色（错误红、品牌印）才允许硬编码。新硬编码色 = 浅色主题下的隐患。
3. **布局契约不可破坏**。各文件头部/注释里标了「滚动宿主/定位/尺寸钳制为功能契约」的规则（如 `.chat-messages` 的滚动、`.layout-*` 的 flex 关系），改前先看注释。

## 三、常见修改怎么做

**改某个组件的样式**：在上表找到管它的文件，直接改；文件头部注释就是原分区说明。

**新增一个组件的样式**：
1. 优先塞进它所属功能分区 的现有文件；
2. 全新独立组件 → 新建 `NN-slug.css`（编号顺着当前最大号往下排，如 `31-xxx.css`）；
3. 在 `index.css` 按层叠意图登记（普通组件放 30-themes 之前；带主题覆盖的组件，主题回写留在 30-themes）；
4. 文件顶部写一行注释说明管什么。

**排查样式不生效**：先确认 `index.css` 里的导入顺序——是不是被更晚导入的文件同名规则覆盖了。

## 四、主题系统（加一个新主题共 5 步）

机制：`:root` 定义深色默认 → `html[data-theme='xxx']` 用变量覆盖实现换肤 → 少数历史硬编码深色的组件在 30-themes 里「定点回写」。前端把 `document.documentElement.dataset.theme` 设为主题 id，所有变量即刻生效。

新主题 id 例：`aurora`。步骤：

1. **变量块**（`30-themes.css`）：`html[data-theme='aurora'] { color-scheme: …; --bg/--bg-panel/--text/--border/--accent/--gold… }`——极光黑可以抄去改色；
2. **硬编码回写**：检查 `08-composer`（`.prompt-input` 渐变）、`26b`（`.status-bar` 渐变）这两个已知硬编码渐变，为主题补对应背景；全屏遮罩 `.modal-mask` 浅色系需要回写；
3. **主题卡片**（`App.tsx` 设置中心「外观」页签）：加一张 `.theme-card` + `.swatch-xxx` 色板（样式在 30-themes）；
4. **前端类型**（`App.tsx` 顶部）：`theme` state 的联合类型加新值 + 标题栏 overlay 配色映射（`window.storyDesktop?.setTitleBarOverlay`，浏览器环境自动跳过）；
5. **首帧防闪**（`apps/web/index.html` 头部内联脚本）：白名单里加新 id。

现有主题：`dark` 深夜书房（默认）｜`light` 宣纸白昼（米黄）｜`white` 纯白｜`aurora` 极光黑（冷黑+青绿 accent）。

> 浅色系（light/white）共享的硬编码回写用逗号并列两个选择器；只有渐变底色不同的（status-bar/prompt-input）各写一条。

## 五、其他约定

- **z 序**只用 `00-tokens.css` 的 `--z-*` 谱（toast 80 < modal 100 < 欢迎页 70 例外见令牌注释）；
- **动画时长/缓动**用 `--t-fast/--t-med/--ease`；新 keyframes 放 `25-animation.css`（组件私有的放组件文件里也行，如 `sb-pulse` 在 26b）;
- 全局 a11y 降级在 `27-a11y.css`；组件内新增动画建议同步加 `prefers-reduced-motion` 覆盖（参考 26b 底部写法）；
- 改完跑 `pnpm build`（tsc + vite build 能抓 CSS 语法/路径错误），主题改动顺手切一遍四主题看对比度。
