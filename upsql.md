# Story Studio 修改日志（upsql.md）

## 1. Provider 高级配置 + 图片输入开关 + Token 统计中断兜底

### 1.1 Provider 配置扩展（上下文窗口/输出上限/图片/采样参数）

- `apps/server/src/settings.ts`：`ModelProvider` 新增可选字段 `contextTokens`（输入上下文窗口，未配置=按模型 ID 识别容量）、`maxOutputTokens`（输出上限，未配置=16384）、`supportsImages`（图片输入开关，默认 false）、`temperature`/`topP`/`topK`（采样参数，未配置=不随请求下发）。旧 settings.json 无这些字段自动按未配置处理，兼容不改。

- `apps/server/src/routes/settings.ts`：PUT 时 `sanitizeProvider` 数值清洗——contextTokens(1k~~10M 整数)、maxOutputTokens(1k~~2M 整数)、temperature(0~~2)、topP(0~~1)、topK(1\~100 整数)，非法值丢弃回退默认，不报错。

### 1.2 agent-core 消费高级配置

- `packages/agent-core/src/agent.ts`：`ChatStreamOptions.modelOverrides` 扩展携带 6 个新字段；上下文容量 `capacity.tokens` 改为 Provider 配置优先（`contextTokens ?? modelContextTokens(modelId)`）；输出上限三级优先（请求级 > Provider 配置 > 16384）；采样参数仅配置时下发（temperature/topP/topK 为 ai SDK 标准参数，网关不支持的自行忽略）。

- `apps/server/src/routes/chat.ts`：`modelOverrides` 构造透传新字段。

### 1.3 设置面板高级配置 UI

- `apps/web/src/panels/SettingsPanel.tsx`：API key 行后新增四个配置区——上下文窗口（输入，快捷档 128k/256k/512k/1M）、输出上限（快捷档 4k/16k/32k/128k，placeholder 提示写长章建议 32768）、支持图片输入（radio 支持/不支持，默认不支持）、采样参数（Temperature/Top P/Top K 三联输入 + 「小说创作推荐（T 1.3 / P 0.95）」一键填充 + 清空按钮 + 说明文字：留空不携带走服务端默认、小说创作推荐 T1.3、TopK 多数端点不支持建议留空）。编辑/新建/激活加载均带新字段。

- `apps/web/src/styles/04-settings-modal.css`：新增 `.settings-adv-group/.settings-chip-row/.settings-chip(.on)/.settings-sampling-row/.settings-sampling-field/.settings-sampling-name` 样式。

### 1.4 图片输入按 Provider 开关生效

- `packages/shared/src/index.ts`：`ServerConfig.models` 元素加 `supportsImages?`，新增 `activeModelId?`（激活 Provider id）。

- `apps/server/src/routes/api.ts`：`/api/config` 透出每 Provider 的 `supportsImages` 与 `activeModelId`。

- `apps/web/src/chat/ChatComposer.tsx`：按输入栏选中 Provider（未选=激活 Provider）计算 `curSupportsImages`；不支持时「+」菜单隐藏图片附件项、选图/拖图/发送带附件三处拦截并提示；切到不支持的模型自动清空待发附件。

- `apps/web/src/chat/ChatPanel.tsx` + `apps/web/src/App.tsx`：透传 `activeModelId`。

### 1.5 Token 统计中断兜底（runKey 幂等落盘）

- 痛点：此前仅 agent-core `onFinish` 最终快照（durationMs>0）落盘 usage-stats.jsonl，用户中途停止/断开时最终快照可能永不到来，本轮已消耗的 token 不落账。

- `apps/server/src/routes/chat.ts`：每轮生成 `runKey`；逐步快照缓存 `lastUsageSnap`；SSE 流关闭的 finally（正常/异常/客户端断开均触发）若未落过盘则用最后快照兜底补落；后台 agent 稍后正常收尾时最终快照按同一 runKey 覆盖兜底记录，不双计。

- `apps/server/src/usageStats.ts`：`UsageRecord` 加可选 `runId`；`appendUsageRecord` 支持 `{ upsertByRunId: true }`——文件末条 runId 相同时覆盖末条（幂等合并），旧记录（无 runId）直接追加不受影响。

### 验证

- `pnpm -r typecheck` 通过（shared/skills/desktop/web/tools/preview-core/agent-core/server 全部 Done）。

## 2. 门禁规则调整：移除 em-dash 破折号门禁 + 新增「不X，白不X」重复谚语规则

### 2.1 移除 em-dash（破折号）blocking 门禁

- 痛点：正文/编辑保存时破折号（——/—/--）被 check-ai-patterns 逐处按 blocking 报错，命中即强制改写；破折号属正常中文标点，保留给 normalize-punctuation.js 做软性归一即可，不应作为硬门禁。

- `packages/skills/<四技能>/scripts/check-ai-patterns.js`：删除 `scanProsePatterns` 里的破折号检测块（`dashPattern = /——|—|--+/g` 及其逐处 blocking finding）；同步清理 USAGE 与 severity 列表里的 em-dash 提及、头部注释。

### 2.2 新增「不V，白不V」俏皮重复谚语 blocking 规则

- 痛点：口语谚语「不偷听，白不偷听」这类「不X，白不X」复读（=「不吃白不吃」族）读感绕弯、读者第一眼未必看懂，用户要求改为直白因果（如「错过才是傻子」）。

- `packages/skills/<四技能>/scripts/check-ai-patterns.js`：新增常量 `REDUPLICATIVE_COLLOQUIAL_PATTERN = /不([\u3400-\u9fff]{1,3})[，,]?\s*白不\1/g` 与检测函数 `findReduplicativeColloquial`（maskQuoted 豁免引号、逐处 blocking，message 建议改写为直白因果/具体动作）；在 `scanProsePatterns` 注册调用；USAGE 增补说明。

- 四份拷贝（story-long-write / story-review / story-short-write / story-deslop）同步修改，SHA-256 校核一致。

### 验证

- `node check-ai-patterns.js --check --fail-on=blocking` 本地验证：「不偷听，白不偷听」「不偷听白不偷听」均命中新规则 exit 1；含「错过才是傻子」的干净文本 exit 0；`正文/第002章_师尊.md`（原 em-dash 报错样例）exit 0。

## 3. 修复：阅读器正文右侧被裁（每行右端看不全）

### 3.1 根因与修复

- 痛点：手机仿真阅读器（WorkPanel「可视化」→ Reader）正文每行右侧一两个字被裁掉/遮盖，窄屏尤其明显。

- 根因：`Reader.tsx` 的 `recalcMetrics` 原按外层 `.reader-body` 的全宽估算每行字数 `charsPerLine`，但实际行容器 `.page-lines` 自带 `padding: 14px 20px`（左右共 40px），未扣除该内边距导致每行被多放约两个字 → 行文本超出内容盒 → 被 `.page-line` 的 `overflow:hidden` 裁掉右端。

- `apps/web/src/reader/Reader.tsx`：`recalcMetrics` 改为优先取 `.page-lines` 内容盒度量（`el.querySelector('.page-lines')` + computed padding），未渲染时按左右 40px、上下 28px 兜底；宽高扣除内边距后再算字形数与每页行数。

### 验证

- `apps/web` 目录 `npx tsc --noEmit` 通过。

## 4. 移除 tracking commit 的标点检测门禁（em-dash / ellipsis）

### 4.1 变更

- 痛点：章节 tracking commit（storyctl chapter\_check 质量预检）被 `PUNCTUATION_NOT_NORMALIZED` 拦下（em-dash/ellipsis 未归一即禁止提交），与已移除的 check-ai-patterns em-dash 门禁重复、过度咬文嚼字。

- `packages/skills/vendor/story-long-write/scripts/storyctl.py`：`check_blocking_quality` 删除 `normalize-punctuation.js --check` 的 blocking 判定（不再产生 `PUNCTUATION_NOT_NORMALIZED`）。注：正文全量门禁（gate.runFullGate）里 normalize-punctuation 写模式仍会软性归一标点，但不再因标点阻断提交/写作。

### 验证

- `python -m py_compile scripts/storyctl.py` 通过。

## 5. 移除长度门禁 + 新增三类啰嗦句式门禁

### 5.1 移除 tracking commit 的字数门禁

- `packages/skills/vendor/story-long-write/scripts/storyctl.py`：`chapter_commit` 删除按 length 状态拦截的 `require(...)`（原来 under/over 必须带 accept-current-length 才能提交）；现在字数只作参考并记 `resolution`，不再阻断提交。`length` 字段与 `compression` 仍随 check 返回供参考。

### 5.2 新增三类「太啰嗦」blocking 句式

- 痛点：①「说好过也好过，说难熬也难熬」说X也X，说Y也Y 空转对仗；②「动不得，说不得」X不得，Y不得 语义含糊；③「他还能干什么？什么都干不了。」徒劳自问自答、空转絮语。

- `packages/skills/<四技能>/scripts/check-ai-patterns.js`：新增常量 `VERBOSE_REFLEXIVE_PATTERN`（说X也X，说Y也Y）、`DEBUDE_ECHO_PATTERN`（X不得，Y不得），及三个检测函数 `findVerboseReflexive` / `findDebudeEcho` / `findRhetoricalQaEcho`（跨段 ≤3 行匹配「还能干什么？」+「什么都干不了。」组合，maskQuoted 豁免引号）；`scanProsePatterns` 注册调用；USAGE 增补说明。四份拷贝 SHA-256 校核一致。

### 验证

- `node check-ai-patterns.js --check --fail-on=blocking`：三条示例均命中对应新规则 exit 1；正常句未误报。

- `python -m py_compile scripts/storyctl.py` 通过。

## 6. 移除人工保存的 normalize 标点提示

- 痛点：编辑器手动保存正文时，`runHumanGate` 仍会以 `--check` 跑 `normalize-punctuation.js`，并把破折号/省略号按标点建议提示给用户；此前已移除同类 blocking 门禁，这里也只剩打扰。

- `packages/tools/src/gate.ts`：`runHumanGate` 移除 `normalize-punctuation.js --check` 这一项，检测脚本精简为 check-ai-patterns / check-outline-copy / check-degeneration，人工保存不再收到标点归一提示。

### 验证

- `packages/tools` 目录 `npx tsc --noEmit` 通过。

## 7. 新增「对话引号内句中句号」blocking 门禁

- 痛点：直接引语里出现非末位「。」、被句号从中截成两段再接话（`"他放下茶杯，又补了一句。说完便走。"`）。经用户确认：**宽口径，任何非末位句号都报**（短应和「知道了。」与长句「他放下茶杯…」都抓），正常多句台词（`你且先退下。此事容我三思。`）会一并命中，由人工判断是否改写。

- `packages/skills/<四技能>/scripts/check-ai-patterns.js`：新增 `findMidSpeechPeriod`——遍历引号区间，找到引号内非末位 `。` 且其后仍有可见内容即报 blocking，同一引语只报第一处；排除 `【】`系统面板（公告正文不受影响）。注册进 `scanProsePatterns`；USAGE 增补。四份拷贝 SHA-256 校核一致。

### 验证

- `node check-ai-patterns.js --check --fail-on=blocking`：`昨日断案…莽汉。做得尚可。`命中；`稳健。明日…`命中；`你且先退下。此事容我三思。`按预期一并命中；`【系统】`面板行豁免；无引号行不报。

## 9. 质检下拉检测项支持点击跳转到对应语句编辑

- 痛点：手动保存并刷新后弹出的「质检提示」每条检测是纯文本（`<pre>`），点不了；用户希望点某条能直接定位到编辑器对应语句修改。

- `apps/web/src/panels/EditorPanel.tsx`：

  - 新增 `parseFindings`：解析检测脚本 output 中 `file:line:column: [severity] type: message` 行 → 结构化 `{line,column,severity,type,message}`（正则定位 `:行:列: [severity] type:`，兼容 Windows 盘符冒号）。

  - 新增 `jumpTo(line,column)`：按行/列换算绝对字符偏移后，以句末标点（`。！？!?…`、换行、右引号）为界圈出包含发现点的**整句**选中（不再「从发现点到行尾一整段全选」，避免整段长行高亮糊一片不准确），并按行高滚到可见、切编辑态。

  - 门禁渲染块：`.eg-item` 内不再直接输出 `<pre>`，改为逐条可点击的 `.eg-find` 按钮行（severity 徽标 + type + message），点击触发 `jumpTo`；无法解析成 findings 时回退 `<pre>`。

- `apps/web/src/styles/16-editor.css`：新增 `.eg-list/.eg-find/.eg-sev(.blocking/.advisory)/.eg-type/.eg-msg` 样式；并为 `.editor-textarea::selection` 加金色高亮（rgba(224,181,92,.55) + 深色文字），让跳转选中的那句在编辑器里一眼可辨。

- 定位再校准（9.x 追加）：`jumpTo` 的整句选中改为以「句末标点 + 引号(“/「/”/」) + 换行」为界；发现点本身是句号时越过它继续向前，命中点落在引语内时整段引语被框住，避免把引语前的大段旁白一起选中、也不再戛然而止于句中句号。已用第004章真实 mid-speech 检测逐条复现验证选中范围。

## 10. tracking 提交 dry-run 预校验（方案 B）

- 痛点：commit 时 `normalize_transaction` 只报第一个错误，且契约对模型不可见（model 只能凭猜构造 payload，把数组字段写成对象，反复撞「must be a JSON array」）。

- `packages/skills/vendor/story-long-write/scripts/tracking_commit.py`：

  - 新增 `structural_type_errors`：把「应为数组/对象/整型/mode」的字段类型错误一次性聚拢成清单。

  - `normalize_transaction` 开头先跑结构预扫，有错即抛聚合错误——让现有 commit 路径（含 storyctl chapter commit）一次性列出全部结构错误，不再一个字段卡一轮。

  - 新增 `validate` 子命令 + `validate_transaction`：dry-run，跑 `load_state`+`normalize_transaction` 但不落盘不加锁，返回 `{valid, errors}`（结构错误全量 + 深层首个语义错误，去重）。

- `packages/tools/src/tracking.ts`：tracking 工具新增 `mode:'validate'`（写 txnFile 后跑 `tracking_commit.py validate`，返回全部字段级错误），description 补充说明 commit 前先 validate 可一次修完。

### 验证

- `python tracking_commit.py validate`：坏 payload（character\_changes/foreshadow\_changes/timeline\_events 传为对象/字符串）一次返回三条字段级错误。

- `py_compile` 与 `npx tsc --noEmit`（tools）通过。

### 验证

- `apps/web` 目录 `npx tsc --noEmit` 通过。

## 8. Token 统计新增「最近任务记录」列表（任务描述/模型/时长/Token 消耗）

- 痛点：任务消耗的 token 虽已按轮落盘 usage-stats.jsonl，但统计页只展示聚合结果，看不到逐条记录；记录里也没有「任务描述」，无法回溯某次任务花了多少。

### 8.1 数据层：记录携带任务描述

- `apps/server/src/usageStats.ts`：`UsageRecord` 新增可选 `title`（任务描述 = 会话标题，取首条用户消息前 40 字；旧记录缺省兼容）；抽取 `readAllRows()` 供聚合与列表复用；新增 `listUsageRecords(limit)` 返回最新 N 条（倒序）。

- `apps/server/src/routes/chat.ts`：`flushUsage` 落盘时写入 `title: activeSession.meta.title`（正常结束与中断兜底两条路径均覆盖）。

### 8.2 接口

- `apps/server/src/routes/api.ts`：新增 `GET /api/usage/records?limit=`（默认 20，上限 100），返回最近 N 条原始轮次记录。

### 8.3 UI：统计页最底部任务记录表 + 实时刷新

- `apps/web/src/components/UsageStats.tsx`：最底部（今日/本周/累计卡片后）新增「最近任务记录」卡片——列：时间 / 任务描述（含任务类型小字）/ 模型 / 时长 / Token 消耗（输入+输出合计，下方小字输入·输出明细）；挂载时拉取 `/api/usage/records?limit=30`。

- `apps/web/src/App.tsx`：`agent:usage` 收到最终快照（`durationMs>0`，任务完成）时广播 `usage:new-record` 事件；UsageStats 监听该事件自动刷新——统计页开着时任务完成即见新记录置顶，无需重开设置。

- `apps/web/src/styles/31-usage-stats.css`：新增 `.us-records-*` 系列样式（卡片头/滚动容器/长文本省略/token 明细）。

### 8.4 任务描述改为完整用户输入 + 悬停查看全文

- `apps/server/src/routes/chat.ts`：任务描述由会话标题（首条消息前 40 字截断）改为首条用户输入问题的完整文本（上限 500 字防膨胀，缺失时回退会话标题）。

- `apps/web/src/components/UsageStats.tsx`：任务描述单元格加 `title` 悬停提示——列表超宽以省略号截断展示，鼠标靠近显示完整输入内容。

### 验证

- `apps/web` 与 `apps/server` 目录 `npx tsc --noEmit` 均通过。

## 9. 资源管理器文档可编辑 + DocWorkbench 富文本编辑器 + 正文手机阅读入口

- 背景：资源管理器打开的文件此前强制只读（WorkPanel 设 `readOnly:true` + DocWorkbench `preload` 强制只读）；编辑器仅 Markdown textarea，无字体/颜色等正式格式；正文只能进「可视化→阅读」手翻章。

### 9.1 通用文件写入通道（需求 1 的基础）

- `apps/server/src/routes/workspace.ts`：新增 `PUT /api/file?path=`——工作区沙箱内任意文本文件写入（`resolveSandboxPath` 相对/绝对路径均可、`forWrite` 校验），`isProtectedDerivedPath` 拦截 `追踪/` 与 `.story/作者记忆/`，已存在文件仅允许文本扩展（md/txt/json/yaml/csv/html/css/js/ts/py/sh/svg 等），缺目录自动建。保存触发 watcher → 资源管理器热刷新。

- `apps/web/src/api.ts`：新增 `saveFile(path, content)`。

### 9.2 资源管理器文档可编辑（放开只读 + 保存分流）

- `apps/web/src/panels/WorkPanel.tsx`：openFile effect 不再设 `readOnly:true`（追踪/ 派生视图由 DocWorkbench 按路径判定只读）。

- `apps/web/src/panels/DocWorkbench.tsx`：`readOnly` 去掉 `preload !== undefined` 强制只读；保存分流——绝对路径（资源管理器打开）→ `saveFile`，相对路径（资料卡）→ `saveDoc`。

### 9.3 DocWorkbench 富文本编辑器（需求 2，WYSIWYG）

- 新依赖（apps/web）：`quill@2`、`turndown@7`、`turndown-plugin-gfm`、`@types/turndown`（dev）；`turndown-plugin-gfm` 无官方类型，新增 `src/turndown-plugin-gfm.d.ts` 声明。

- `apps/web/src/panels/DocWorkbench.tsx`：非正文章节、非 JSON 文档进入编辑模式用 **Quill snow 富文本**——工具栏含标题/加粗/斜体/下划线/删除线/文字颜色/背景色/字体族（楷体/黑体/仿宋/微软雅黑等）/字号(12-24px)/对齐/有序无序列表/引用/链接/图片/代码块/清除格式；markdown-it 改 `html:true` 保留内嵌样式；保存用 `turndown`（gfm 表格规则 + keep span）序列化回 Markdown，颜色/字号以内嵌 HTML 存 .md 往返还原。

- 表格保真：`containsTable()` 检测文档含表格时，进入编辑自动回退 Markdown textarea（富文本无法结构化编辑表格，防 `设定/关系.md` 等表格损坏）。

- `apps/web/src/styles/29-panel-fn.css`：新增 Quill 深色主题适配（工具栏/图标/下拉/编辑区配色、字体下拉 content 映射、`.ql-font-*` 字体 class）。

### 9.4 正文章节「手机可视化阅读」入口（需求 3）

- `apps/web/src/components/Explorer.tsx`：识别 `第NNN章*.md` 正文文件（`细纲_` 等前缀不误判），文件行右侧新增「手机阅读」快捷按钮（book-open 图标）+ 右键菜单「手机可视化阅读」。

- `apps/web/src/App.tsx`：新增 `readChapterFromPath`（正则解析章号 → 复用 `setChapterJump`），经 `onReadChapter` 传给 Explorer；WorkPanel 收到 jumpSignal 自动切「可视化→阅读」并定位章节。

- `apps/web/src/styles/28-workbench.css`：`.fx-read` 手机阅读按钮样式。

### 验证

- `apps/web` 与 `apps/server` 目录 `npx tsc --noEmit` 通过；`apps/web` 目录 `npx vite build` 通过。

- 往返链路 `md → markdown-it(html) → turndown(gfm) → md` 验证：标题/粗斜/代码/链接/引用/列表/代码块/表格/内嵌颜色 span 均保真。

- 沙箱验证：绝对/相对路径可写、越界拒绝、`追踪/` 与 `.story/作者记忆/` 拦截、普通设定放行；章节识别 `第0001章`→index 1，`细纲_第001章`/设定文件不误判。

## 11. 优化模式分流：精简去追踪 + 升华提质支路（作者批准免检）

痛点：① 优化（去AI味）完稿还会提交 tracking revision 事务，纯文笔优化不改故事状态，revision 被无谓 bump、浪费对账；② 单一流程强制白描，华丽文风（排比/氛围句/点题）会被门禁脚本点名，无法做「高贵脱俗」式提质。
方案：优化必须二选一倾向（精简/升华）——精简=现行去AI味但只更新正文（保留门禁，不碰追踪）；升华=只读「本章细纲+本章正文+前一章正文」直出不跑门禁，审批确认后登记「作者已确认」免检。

### 11.1 精简支路：去 tracking + 定稿字数达标

- `packages/agent-core/src/modes.ts`：polish 模式提示词拆为「精简（默认）/升华」两条子流程；精简流程删除「提交 tracking revision 事务」，改定稿标准 = 门禁通过（blocking 清零）+ 字数达标（对照本章细纲字数目标下限，跌破降 AI 重写补足），并明确「完稿后不提交任何 tracking 事务、不更新追踪状态」。

- `apps/web/src/panels/PolishPanel.tsx`：精简 prompt 同步去掉 tracking，加入字数达标定稿标准。

### 11.2 升华支路：三件套直出 + 作者批准指纹注册表（免检）

- `apps/web/src/panels/PolishPanel.tsx`：新增「精简/升华」必选倾向选择器（未选禁发），升华 prompt 以机器标记 `<!--polish-variant:elevate-->` 开头，指示 Agent 只读细纲+本章+前章、Write 全量改写、不跑质检/门禁、停在审批卡确认。

- `apps/server/src/routes/chat.ts`：每轮先 `gate.clearPendingApproval()`，再检测「末条用户消息含升华标记 + approval-responded 已批准 Write/Edit + 目标为 正文/\*.md」→ `gate.approveNextWrite(abs)`，保证免检只在检测到审批的同一轮内有效。

- `packages/tools/src/gate.ts`：新增作者批准注册表 `.story-studio/approved.json`（相对路径 → sha1 指纹 + 时间 + 来源）；`runFullGate` / `runHumanGate` 先查注册表——指纹命中直接 PASSED（合成 `author-approved` 脚本报告并照发 `gate:result` 事件）；内容被后续 AI 改动 → 指纹失配自动清注册项、恢复完整门禁。`approveNextWrite` 一次性消费，`registerApproval`（来源 agent-approval / manual）。

- `apps/server/src/routes/workspace.ts`：`PUT /api/file` 与 `PUT /api/chapter/:index` 支持 `authorApproved=true`（正文登记 manual 免检）；`GET /api/file` 返回 `approved` 状态。

- `apps/web/src/api.ts`：`saveFile`/`saveChapter` 支持 `authorApproved`；新增 `fetchWorkspaceFileMeta` 读 approved。

- `apps/web/src/panels/DocWorkbench.tsx` + `styles/17-cards-docs.css`：正文保存时显示「作者已修改 · 标记免检」勾选（仅 正文/\*.md），保存后回执「已保存 · 此版已标记「作者已确认」免检」。

### 11.3 精简支路审批 UX：临时稿验收 + 单次 Write 写回（整章红删绿增一次确认）

- 痛点：精简按 story-deslop「逐 Gate 清改」，Agent 每处修复一个 Edit，rewrite-only 策略下每个 Edit 都弹一张审批卡——用户看到十几张零碎确认，而不是一章完整的合成 diff。

- `packages/agent-core/src/modes.ts` + `apps/web/src/panels/PolishPanel.tsx`：精简 prompt 新增「写改纪律」——先在 `.story-studio/tmp/` 临时稿（新文件，不触发审批/门禁）逐 Gate 清改并用 Bash 跑质检脚本验收至 blocking 清零；验收通过后一次性 Write 全量写回正文章节，全程仅一张审批卡，卡内展示整章红删绿增 diff，用户一次确认；被拒则改临时稿重走，不对正文写中间态。

### 验证

- `pnpm -r typecheck` 通过（shared/skills/desktop/web/tools/preview-core/agent-core/server 全部 Done）；`apps/web` `vite build` 通过。

- 链路语义：升华审批通过 → 落盘免检并登记注册表；此后再跑精简/写模式改动同章 → 指纹失配 → 注册项清除、恢复 4 脚本门禁。

## 12. 同人衍生模式（fanfic，第 8 个模式）

- 需求：基于既有原著写同人文。7 步流程：①联网检索统计原著设定（世界观/势力/角色，逐项用户确认后落盘 原著/）→ ②15 问问卷统计专属设定并生成同人侧全套设定 → ③拆书（上传原著 TXT 逐卷 ≤2MB，切片+逐章摘要+聚合时间线/角色发展，用户确认）→ ④完善卷设定/卷纲/时间线对比 → ⑤逐章确认细纲 → ⑥切 write 模式复用创作闭环 → ⑦第二卷回拆书循环。进度文件 `原著/_progress.json` 断点续传，跨会话「继续同人」恢复。

### 12.1 模式注册与搜索源注入

- `packages/shared/src/index.ts`：`ModeId` 加 `fanfic`；MODES 加同人条目（icon dna）；WsEvent file:changed kind 加 `source`；新增 `FanficSearchSite` / `DEFAULT_FANFIC_SEARCH_SITES`（萌娘百科/百度百科/维基/贴吧/B站/起点）/ `FanficVolumeProgress` / `FanficProgress` 类型。

- `packages/agent-core/src/modes.ts`：`MODE_DEFS` 新增 fanfic（prompt 含 7 步流程/断点续传/产物分流/拆书纪律/交接与会话建议；tools=只读+Write/Edit/Bash；approval=rewrite-only 新建放行改写停靠；defaultPanel=fanfic）。

- `packages/agent-core/src/router.ts`：RULES 加同人规则（置于 write 前，防「写同人」被抢）；VALID\_MODES/MODE\_OPTIONS 补 fanfic。

- `packages/agent-core/src/prompt.ts` + `agent.ts` + `apps/server/src/routes/chat.ts`：`BuildPromptOptions`/`ChatStreamOptions` 加 `modeContext`，仅 fanfic 模式拼进系统提示词；chat.ts 按 settings 组装搜索源清单（site: 用法 + 不编造/矛盾标注纪律）。

- `apps/server/src/settings.ts` + `routes/settings.ts`：SettingsFile 加 `fanficSearchSites`（load 容错）；PUT 清洗（≤12 条、host 合法、id 唯一）、GET 未配置返回默认清单。

- `packages/tools/src/index.ts`：switch\_mode description「7 种」→「8 种」。

### 12.2 服务端 API 与 WS 监听

- `apps/server/src/routes/fanfic.ts`（新）：`POST /api/fanfic/source`（content 1000\~220 万字符校验、卷号 1-99、文件名安全化、落盘 原著/原文/、同卷重传 409、初始化/追加 \_progress.json volumes）+ `GET /api/fanfic/progress`（读 \_progress.json + 磁盘派生真值：摘要计数 countSummaries、chapters 优先边界.json、原文清单、时间线对比清单）。

- `apps/server/src/ws.ts`：kindFor 加 `原著/ → source`；chokidar watch 数组加 原著/ 目录（前端同人面板经 file:changed kind:'source' 自动刷新）。

- `apps/server/src/index.ts`：注册 registerFanficRoutes。

### 12.3 story-fanfic 技能（local，vendor 同步不覆盖）

- `packages/skills/local/story-fanfic/`（新）：SKILL.md（场景路由表/七步总览/停靠点纪律/第 6 步 switch\_mode 交接/时间线溢出协议）+ references/ 五份（step1 原著设定检索与四项确认、step2 15 问问卷拆 8+7 两批+同人侧产物清单+题材正文提示卡「同人纪律」块、step3 拆书管道、step4-5 卷纲细纲与时间线对比格式、progress-protocol 进度 schema 与写入纪律）。

- `packages/skills/local/story-fanfic/scripts/split-source.js`（新）：确定性章节切片——中文数字章号转换、序章/楔子→第 0 章、番外跳过计数、目录块剔除（重号交集法：开头密集段与后文章号交集 ≥3 判目录、段内每章号保留最后一次出现，正文首章不误杀）、卷内重号 exit 1、幂等（已有切片拒绝重切）；产出 章节/\*.md（首行归一 `# 第NNN章 标题`）+ 边界.json。

- `packages/skills/local/package.json`（新）：`{"type":"commonjs"}`（对齐 vendor/package.json，使 scripts/ 下 require 风格脚本可执行）。

### 12.4 FanficPanel 前端面板

- `apps/web/src/panels/FanficPanel.tsx`（新）：七步步骤条（当前高亮/完成打勾）+ 按步骤条件渲染 CTA（onSendToAgent 发预设话术）+ 原文上传区（file input + 卷号/卷名 → TextDecoder UTF-8 fatal 失败回退 GBK → 上传成功自动移交 Agent 拆书）+ 拆书卷进度行（summarized/chapters 进度条 + 状态 chip）+ 原文清单 + 时间线对比双泳道（解析 `<!--fanfic-timeline v1-->` 表格，原著灰/同人 accent、「分岔点」高亮，解析失败降级原文）；wsEvent kind:'source' 触发刷新。

- `apps/web/src/api.ts`：`uploadFanficSource` / `fetchFanficProgress`。

- `apps/web/src/panels/WorkPanel.tsx`：View 加 fanfic、tab 区「同人」按钮（dna）、渲染区挂 FanficPanel；`App.tsx`：MODE\_DEFAULT\_VIEW/MODE\_DEFAULT\_DOC 加 fanfic。

- `apps/web/src/components/SettingsModal.tsx` + `FanficSettings.tsx`（新）+ `App.tsx`：设置中心加「同人」页签（搜索源 name+host 行编辑/删除/添加/恢复默认/保存）。

- `apps/web/src/styles/20b-fanfic.css`（新）+ index.css 引入：步骤条/上传/卷进度/双泳道/设置页样式。

### 验证

- `pnpm -r typecheck` 通过；`apps/web` vite build 通过。

- split-source.js 样例：含目录块+10 章+番外 → 剔目录 10 行、切 10 章、跳番外 1；同章号两次 → exit 1 报重号；重传 → 幂等拒绝。

- 端到端（本地服务）：POST /api/fanfic/source 落盘 原著/原文/ 并初始化 \_progress.json（step=1、卷登记）；GET /api/fanfic/progress 返回 exists/volumes/sourceFiles 派生真值，删除后恢复空态；GET /api/settings 返回 6 条默认搜索源。

## 13. 同人模式首批体验反馈修复（8 项）+ 问答表单/统计口径改进

### 13.1 同人面板：欢迎页 + 上传区限拆书步骤（问题 1/6）

- `apps/web/src/panels/FanficPanel.tsx`：新增欢迎形态（无进度或第 1 步未获知原著信息时显示）——七步指南（每步一句说明）+ 原著信息输入栏（书名\* / 作者 / 总字数）+「开启同人创作」按钮（把面板信息组装为指令发给 Agent 走第 1 步）；上传区改为仅第 3 步（拆书）/ 第 7 步（循环拆书）时显示，其余步骤隐藏。

- `apps/web/src/styles/20b-fanfic.css`：新增 .fanfic-guide\*（指南/表单/开启按钮）样式。

### 13.2 设定确认内容面板可视化——草稿机制（问题 2）

- `packages/shared/src/index.ts`：FanficProgress 新增 `draftFiles`（原著/草稿/\*.md 清单）。

- `apps/server/src/routes/fanfic.ts`：GET progress 扫描 原著/草稿/ 返回草稿清单。

- `packages/skills/local/story-fanfic/references/step1-source-settings.md`：第 1 步确认协议改为草稿先行——检索总结先 Write 到 原著/草稿/{项名}.md（面板全文展示），聊天只发 ≤200 字简讯；偏差循环改草稿再确认；确认后草稿拆分转正（势力/角色一文件一个）并删除草稿文件。SKILL.md 停靠纪律与目录结构同步。

- `packages/agent-core/src/modes.ts`：fanfic prompt 增加「原著设定确认走草稿」纪律。

- `FanficPanel.tsx`：新增「待确认设定」区——逐份草稿全文展示（默认展开、内部滚动）+ 快捷按钮「✓ 确认符合，正式落盘 / ✗ 有偏差」；样式 .fanfic-draft\*。

### 13.3 问答表单输入栏 textarea 化自动增高（问题 3）

- `apps/web/src/chat/ChatPanel.tsx`：QuestionForm 的 input 改为 textarea（rows=2 + autoGrow：onChange 时 height=min(scrollHeight,360)px，切题时按已存答案恢复高度）；保持非受控 defaultValue + key=idx 的 IME 安全模式；Enter 下一题、Shift/Ctrl/Cmd+Enter 换行。

- `apps/web/src/styles/11-question-form.css`：.qform-input 增加 resize:none / overflow-y:auto / min-height / line-height。

### 13.4 Token 统计统一为「整任务」口径（问题 4）

- 痛点：最近任务记录一条 = 一轮 run（单次请求），同一任务的交互轮次（问答/审批确认）拆成多条、时长与 token 各记各的，与用户感知的任务耗时对不上。

- `apps/server/src/usageStats.ts`：UsageRecord 新增 `sessionId` 字段。

- `apps/server/src/routes/chat.ts`：flushUsage 落盘时写入所属会话 id。

- `apps/web/src/components/UsageStats.tsx`：新增 groupIntoTasks——同 sessionId 且相邻记录间隔 ≤10 分钟的轮次聚合为一个「整任务」（时间取最早、标题取首条、模型取末条，token/时长累计、轮数角标）；表格按任务行渲染（标题列显示「模式 · N 轮」）；拉取量 limit 30→80 保证聚合后任务数充足。

### 13.5 同人步骤完成自动切面板（问题 5）

- `apps/web/src/panels/WorkPanel.tsx`：WS file:changed(kind:'source') 且 path 为 原著/\_progress.json 时（Agent 回写步骤状态）自动切到同人视图，用户直接看到下一步操作。

### 13.6 未拆书的卷重传覆盖（问题 7）

- `apps/server/src/routes/fanfic.ts`：上传时若该卷已登记——已有拆书产物（章节/摘要/时间线等任一存在）→ 409（提示删除路径）；未开始拆书 → 允许覆盖：删旧原文、更新登记（source/label 重置计数），返回 overwrite:true。api.ts FanficSourceResult 加 overwrite 字段。

### 13.7 拆书摘要改桥段粒度（问题 8）

- `packages/skills/local/story-fanfic/references/step3-deconstruct.md`：逐章摘要改为桥段摘要——按剧情单元 10-20 章一个桥段（卷尾不足 10 章并入或 ≥3 章单独成段，无分界按 15 章切）；一桥段一次处理（并行 Read → Write 一个摘要）；文件命名 `摘要/第NNN-MMM章.md`（文件名即覆盖区间）；断点真值 = 区间并集；单会话上限改 3 个桥段；摘要模板改为桥段版（覆盖章节/关键事件带章号）。

- `apps/server/src/routes/fanfic.ts`：countSummaries 改为区间解析（chaptersCoveredBy：文件名数字区间展开求并集，兼容旧逐章文件名单章计数）。

- SKILL.md / modes.ts prompt 同步（桥段纪律）。

### 验证

- `pnpm -r typecheck` 通过；`apps/web` vite build 通过。

- 实测（tsx watch 服务热重载后）：GET /api/fanfic/progress 返回 draftFiles 字段；已有 50 个逐章摘要文件（001章\_\*.md 命名）summarized 仍正确计数 50（兼容）；第二卷（无拆书产物）重传 → overwrite:true 覆盖成功；第一卷（已拆书）重传 → 409 拒绝。

## 14. 拆书摘要粒度再放大：一卷约 5 个桥段 + 旧逐章摘要归并

- 需求修正：用户反馈 agent 仍在逐章写摘要；期望「120 章原著 ≈ 5 次摘要拆完」——桥段粒度从 10-20 章放大到每段约 25 章（一卷约 5 段），且已有的 50 个逐章摘要要合并而不是继续逐章。

- `packages/skills/local/story-fanfic/references/step3-deconstruct.md`：

  - 桥段划分公式化：桥段数 = 卷章数 ÷ 25 四舍五入（下限 3、上限 8；120 章→5 段、200 章→8 段）；明确「绝对禁止一章一个摘要文件」；单会话上限 3 桥段；摘要模板扩为 800-2000 字。

  - 新增 3.5 节「旧逐章摘要归并」：开工检测到单章粒度旧摘要（一文件一单章，无论是否带「第」前缀）→ 对已覆盖章号按桥段划段 → 逐段并行读旧摘要合并 Write 为 第NNN-MMM章.md（事件按章号排序去重、跨章事件合并）→ 归并完一段删一段 → 剩余章节按新粒度续拆。归并不回读原文。

- `packages/agent-core/src/modes.ts`：fanfic prompt 拆书纪律改为「一卷约 5 个桥段（每段约 25 章，120 章 ≈ 5 次摘要拆完），禁止逐章写摘要；有旧单章摘要先归并」。

- `packages/skills/local/story-fanfic/SKILL.md` / `references/progress-protocol.md` / `scripts/split-source.js`（stdout 提示）/ `apps/web/src/panels/FanficPanel.tsx`（指南与 CTA 话术）：同步新粒度描述。

- 兼容性：countSummaries 的区间解析（数字并集）对单章/区间两种命名均可计数，进度条不受归并影响。

### 验证

- `pnpm -r typecheck` 通过。用户当前书（第 1 卷 120 章、50 个单章摘要）按新协议：归并成 001-025/026-050 两段 + 剩余 70 章按 3 段续拆 = 全卷共 5 段，符合「5 次摘要」预期。

- 生效条件：需新开会话说「继续同人」（load\_skill 重读新协议；旧会话的上下文惯性会延续逐章模式）。

## 15. 拆书桥段划分优先级：直接采用原著信息.md 的全书分段摘要表

- 痛点：第 1 步检索落盘的 原著/原著信息.md 里已含「段落 章节 摘要」全书分段表（如 1-89 〈段落甲〉、90-120 〈段落乙〉…），是现成的全书时间线骨架；agent 拆书时却无视它自行按公式划段。用户指出应直接参考该表。

- `packages/skills/local/story-fanfic/references/step1-source-settings.md`：新增 3.1 节「全书分段摘要表」——检索到该表必须完整逐行保留进 原著信息.md（唯一不许精简的内容）；没检索到可补搜「{书名} 剧情分段」，仍无则不编造。

- `packages/skills/local/story-fanfic/references/step3-deconstruct.md`：桥段划分改三级优先——①原著信息.md 分段表与卷章节范围求交（首选用，桥段名沿用表中段落名；行>35 章对半细分为上/下）；②无表时按章节标题剧情分界；③公式 ÷25 兜底。桥段摘要模板增加「段落概要」行（源自分段表）。3.5 节旧摘要归并的划段同样优先分段表。

- `packages/skills/local/story-fanfic/SKILL.md`：时间线溢出协议升级——溢出时先对照分段表判断未拆章节走向，告知用户将进入哪个「分段表段落名」再决定拆不拆。

- `packages/skills/local/story-fanfic/references/step4-5-outline.md`：大纲后续卷方向可按分段表粗排（如「第二卷 ≈ 〈段落丙〉121-172 + 〈段落丁〉173-206」）；卷纲剧情单元命名可参考段落名。

- `packages/agent-core/src/modes.ts` + `apps/web/src/panels/FanficPanel.tsx`：prompt 与拆书 CTA 话术同步「桥段划分第一优先级 = 分段表求交」。

### 验证

- `pnpm -r typecheck` 通过。实测实例：第 1 卷（1-120 章）按其分段表 = 〈段落甲〉001-089 + 〈段落乙〉090-120 共 2 个桥段；已拆 50 章归并为 001-050（〈段落甲〉前段），剩余按表续拆——全程无需公式。

## 16. 拆书粒度再校准：分段表「事件展开」而非整段

- 需求再修正：按分段表整行（如〈段落甲〉1–89）一段仍太大——用户期望以行内摘要列的**事件**为桥段（如「事件一、事件二、事件三、事件四」= 4 个桥段），agent 需自行定位各事件的章节范围。

- `packages/skills/local/story-fanfic/references/step3-deconstruct.md`：桥段划分首选改为「分段表事件展开」——取本卷相交行的摘要列按顿号/逗号拆成事件序列，每事件一个桥段；事件章节定位 = 读切片 边界.json 章节标题按语义匹配起止章，标题定位不了的抽样 Read 1-2 章验证；粒度微调（<5 章并入相邻、>35 章拆上下）；目标每卷 4-8 个事件桥段。摘要模板加「所属段落」「段落概要」两行（桥段名即事件名）。3.5 归并划段同步事件展开。

- `step1-source-settings.md` 3.1 节、`modes.ts` prompt、SKILL.md、FanficPanel 指南/CTA：口径统一为「摘要列按顿号拆事件，每事件一桥段，读章节标题定位」。

### 验证

- `pnpm -r typecheck` 通过。实测实例：第 1 卷 1-120 章按其分段表展开 = 事件一 / 事件二 / 事件三 / 事件四 / 事件五 / 事件六 共 6 个事件桥段，符合「5 次左右拆完」预期。

## 17. 拆书单章摘要回退治理：merge-summaries.js 确定性归并 + 存量数据已修复

- 痛点：agent 看到摘要目录里已有的单章文件（001章\_章节标题.md…）就模仿旧格式继续逐章写——prompt 约束敌不过目录里的既有模式，实测旧 50 个单章摘要被继续写到 115 个。

- `packages/skills/local/story-fanfic/scripts/merge-summaries.js`（新）：

  - `--volume N --check`：扫描 摘要/ 目录，发现单章粒度文件（文件名单一章号、非区间命名）→ 列出清单 exit 1（gate 式阻断）；全区间 exit 0。

  - `--volume N --segments "1-36:事件一,37-61:事件二"`：按事件计划确定性归并——区间内单章文件按章号拼接为 第NNN-MMM章.md（原 H1 降级为 `## 第N章` 小节，内容零丢失），删原单章文件；段间重叠/乱序校验、目标存在防覆盖、段外残留文件结尾报错提示补段；幂等可重跑。

- `step3-deconstruct.md` 3.5 节重写为「强制脚本」：开工第一步与收尾必跑 --check；发现单章文件 → 按分段表事件展开+章节标题定位生成 --segments 计划 → 脚本归并到 --check 通过；--check 未通过禁止写新摘要；每写完一个桥段再自查防粒度回退；明示「目录里已有单章文件绝不意味着新摘要也要单章」。

- `modes.ts` fanfic prompt / SKILL.md 停靠纪律同步：开工与收尾必跑 merge-summaries --check。

- **存量数据修复（实测）**：某书第 1 卷 115 个单章摘要按事件归并为 5 个桥段文件（001-036 事件一 / 037-061 事件二 / 062-089 事件三 / 090-115 事件四 / 116-120 事件五），120/120 章全覆盖、内容以小节形式零丢失、--check 复检通过、进度端点计数正确（120/120）；模仿源已消除。

### 验证

- `pnpm -r typecheck` 通过；merge-summaries.js 实测：--check 检出 115 个单章（exit 1）→ 4+1 段两轮归并 → --check 通过（5 个区间文件）；段外残留（116-120）正确报错并补段重跑成功。

## 18. Token 整任务连续显示 + 完全允许开关 + 拆书不落章节文件

### 18.1 输入栏 token 统计：整任务累计（跨问答/审批轮连续显示）

- 痛点：用户回答 ask\_questions 后续跑，执行指示器的 token 面板重置成「首步模型调用尚未返回…」占位符——token 只按单轮 run 显示，与耗时（accMs 跨停靠累计）行为不一致。

- `apps/web/src/chat/ChatPanel.tsx`：新增 baseUsage（任务累计）+ taskEndedUsageRef（区分新任务/续跑）+ runUsageRef 镜像。submitted 时：新任务清零 base；续跑（上轮挂审批/表单结束）把上一轮 runUsage 折入 base（数值求和、上下文字段取最新）；任务真正结束（与 accMs 清零同点）标记 taskEnded。taskUsage = base + 当前轮（上下文占用/容量取最近快照）——指示器与交付卡共用；续跑首轮未返回时显示 base，不再回退占位符。

- `apps/web/src/chat/AgentRunIndicator.tsx`：新增 crossRun 属性——含此前轮次时顶部显示「本次任务累计（含此前问答/审批轮次）」金色标记。

- `apps/web/src/styles/06-chat.css`：.ari-cross 标记样式。

### 18.2 「完全允许」一键放行（默认手动审批）

- 需求：除优化模式外的任务可一键完全允许，不必逐个点审批卡。

- `apps/web/src/chat/ChatPanel.tsx`：autoAllow 状态（默认 false=手动）；审批到达且开关开启时延迟 400ms 自动 addToolApprovalResponse({approved:true})——仅自动放行 Write/Edit（browser\_cdp setup 等高危仍手动）；优化模式（polish）整体禁用（升华作者批准承载免检语义，自动放行会破坏）。UI 两处：审批待决条内「自动放行」勾选 + 输入栏上方常驻「完全允许」chip（可预先开启）。

- 样式：09-approval.css .ap-autoallow、06-chat.css .chat-allow-\*。

### 18.3 拆书不再落章节文件（直读原文）

- 痛点：拆书把原文章节一个个切片复制进 原著/拆书/第V卷/章节/（第 2 卷被 agent 手写了切片还留「139 个切片待补」的过时 gap）——原文已在 原著/原文/，完全不需要中间切片。

- `packages/skills/local/story-fanfic/scripts/split-source.js`：重写为「边界识别」——只产 边界.json（每章 {no,title,startLine,endLine,chars} 行号表），不写章节文件；幂等改为 边界.json 存在即拒绝（--force 仅重写边界不动摘要）；检测到旧版 章节/ 目录时提示可删。

- `step3-deconstruct.md`：第 2 节改为「边界识别（不落章节文件）」；处理方式改为按桥段首末章行号 `Read 原著/原文/xx.txt offset/limit` 直读（≤8000 行，超长续读）；明令禁止 agent 自己 Write 章节切片；旧 章节/ 目录存在时忽略。

- `SKILL.md` 目录树（移除 章节/）、`modes.ts` prompt、FanficPanel CTA/上传提示同步。

- **存量迁移（实测）**：《召唤主宰》书第 1 卷 --force 升级边界行号、第 2 卷新生成边界.json（143 章 8446 行）；删除两卷 章节/ 切片目录（120+4 文件）；清理 \_progress.json 中过时的 sliceGap 字段；GET progress 对新边界格式计数正常（120/143）。

### 验证

- `pnpm -r typecheck` 通过；`apps/web` vite build 通过。

- split-source 实测：5 章样例产出行号表正确（含目录块剔除）；重跑 exit 1；--force 覆盖重写。

- 数据迁移后边界.json/摘要/进度三件套一致，服务端计数正确。

## 19. 同人拆书卷状态磁盘真值派生 + 手动进入下一步（卷设定）

### 19.1 卷状态按磁盘真值派生（修复 120/120 章仍显示「待拆解」）

- 痛点：卷状态直接透传 `_progress.json` 的 `volumes[].status`（agent 维护，易滞后未回写）——实测两卷摘要已 120/120、143/143 全覆盖，面板仍显示「待拆解」。

- `apps/server/src/routes/fanfic.ts`（GET progress）：status 改为派生——`confirmed`（用户已确认，终态保留）> `done`（chapters>0 且 summarized≥chapters，磁盘摘要覆盖全卷）> `in_progress`（已有摘要）> `pending`；summarized/chapters 本就从磁盘数出，状态不再依赖 agent 回写。

- `apps/web/src/panels/FanficPanel.tsx`：VOL\_STATUS 新增 `done → 拆解完成`。

- `apps/web/src/styles/20b-fanfic.css`：`.fanfic-vol-status.done` 绿色标签样式。

### 19.2 拆书完成卷手动进入下一步（第 3/7 步 → 第 4 步卷设定）

- 需求：拆书内容足够支撑同人第一卷后，推进第 4 步不应卡在 agent 的 ask\_confirm 问询——用户需在面板手动勾选所拆的几卷、点击进入下一步。

- `FanficPanel.tsx`：第 3/7 步且存在 done/confirmed 卷时显示「进入下一步（卷设定）」区——已完成卷复选清单（render-phase 派生状态：候选卷清单变化时重置为全选）+ 确认按钮；点击后 onSendToAgent 发送手动下一步指令（① 缺聚合产物先按 step3 第 4 节补齐；② 所选卷 status 置 confirmed；③ step 置 4 并按第 4 步问询本卷内容/字数/时间线锚点）。

- `20b-fanfic.css`：`.fanfic-next` 确认区（accent 描边卡片 + 复选清单）样式。

- Agent 协议同步：`packages/skills/local/story-fanfic/references/step3-deconstruct.md` 第 5 节新增「手动下一步（面板入口）」处理规则；`packages/agent-core/src/modes.ts` fanfic prompt 新增「拆书手动下一步」条目。

### 验证

- `pnpm -r typecheck` 通过。

- 实测场景：第 1 卷（120/120）、第 2 卷（143/143）摘要全覆盖 → GET progress 派生 status=done（面板显示「拆解完成」）；面板出现勾选区，默认全选两卷，点击确认即向 agent 下发进入第 4 步指令。

## 20. 资源管理器编辑文件双 bug：已有文件保存必 415 + 取消编辑黑屏

### 20.1 PUT /api/file 扩展名白名单误判（「编辑 md 文件失败」根因）

- 痛点：资源管理器打开的 md 文件编辑保存必失败，toast「保存失败：不支持编辑该类型文件（.md）」。

- `apps/server/src/routes/workspace.ts`：`TEXT_EXTS`（`/\.(md|…)$/i`）匹配的是**带点**形态，而 `TEXT_EXTS.test(ext)` 传入只取字母部分的 `md`（无点）→ 永远 false → **所有已存在文件**（md/txt/json 等全类型）的保存一律 415 拒绝；只有新建文件（不存在，跳过检查）能写。修复为 `TEXT_EXTS.test('.' + ext)`。

- 实测复现与验证：修复前 PUT `原著/拆书/第1卷/摘要/062-089章.md` → 415；修复后原样回写成功且内容 diff 为零；txt 保存、新建 md、新建 .bin（白名单仅约束已有文件，维持原逻辑）各路径正常。

### 20.2 Quill 2 无 destroy API → 取消编辑黑屏

- 痛点：富文本编辑非正文 md 后点「取消」（或保存成功退出编辑）→ 应用整屏黑掉。

- 根因：`DocWorkbench.tsx` 的 effect cleanup 调 `quillRef.current.destroy()`，但 Quill 2.0.3 运行时与类型定义均**无 destroy 方法**（dist 源码 0 匹配）→ cleanup 抛 TypeError → React 卸载阶段崩溃、无 ErrorBoundary → 黑屏。

- `apps/web/src/panels/DocWorkbench.tsx`：删除 RichQuill 扩展类型与两处 destroy 调用；cleanup 改为还原容器（`className='rich-editor'` + `innerHTML=''`，Quill 事件全绑在 editor root 上随 React 卸载 DOM 自动回收）并断开引用——顺带防 StrictMode 双跑时对已初始化容器二次 new Quill。

- `apps/web/src/main.tsx`：新增全局 ErrorBoundary（内联类组件）——渲染/effect 异常不再整屏黑掉，显示错误信息 + 「尝试恢复」（仅清错误态，适合瞬时崩溃）+「重新加载」按钮。

### 验证

- `pnpm -r typecheck` 通过；`pnpm build`（web）通过。

- 服务端实测见 20.1；前端修复后富文本进入/退出编辑不再抛错。

## 21. 创作校准模式（calibrate）：跨文件矛盾诊断与滞后内容修复

- 需求：项目是活文档——总纲/卷纲/分章规划/细纲/时间线对比/题材定位在多轮修订后失同步（高层文件停在旧决策、已砍设定残留、字数/年龄/书名/锚点各说各话），此前只能手工让 agent 临时分析。产品化为第 9 个模式「校准」。

### 21.1 模式注册（全链路）

- `packages/shared/src/index.ts`：ModeId 加 `'calibrate'`；MODES 加条目（label 校准 / icon target / desc 一致性校准：跨文件矛盾诊断与滞后内容修复）。顶栏 TopCapsule 与 switch_mode 枚举自动生效（都消费 shared MODES）。
- `packages/agent-core/src/modes.ts`：MODE_DEFS 加 calibrate——prompt 声明四阶段流程（盘点→诊断→确认→修复验证）+ 铁律（内容自洽群为基准、歧义必问、不动 正文/追踪/原著拆书、修后必 Grep 验证）；tools = READ_ONLY + Write + Edit（无 Bash/tracking——校准不需要）；defaultPanel='report'（诊断报告实时可见）；approval='rewrite-only'（改用户已确认的设定/大纲必审批，新建放行）。
- `packages/agent-core/src/router.ts`：RULES 加校准正则（校准/一致性检查|诊断|核对/同步设定|大纲|细纲|文件/大纲滞后/矛盾排查/重构大纲→calibrate）；VALID_MODES + MODE_OPTIONS（LLM 兜底分类）同步加 calibrate。
- `apps/web/src/App.tsx`：MODE_DEFAULT_VIEW.calibrate='report'、MODE_DEFAULT_DOC.calibrate='大纲'（Record<ModeId> 穷举映射，TS 强制补全）。
- `apps/web/src/components/GuideModal.tsx`：模式速查表补「同人」「校准」两行（此前同人模式也没进表），「七大模式」文案统一为九大。

### 21.2 story-calibrate 技能（packages/skills/local/story-calibrate/）

- `SKILL.md`：四阶段流程——Phase 1 盘点（结构全景 + 按 checklist 通读文件群 + 建立决策群画像：每个关键决策各文件取值与新旧判断，内容自洽群=多数文件一致且互引无矛盾）；Phase 2 诊断（按清单三类核对 → 问题五元组 位置|旧值|基准值|严重级|建议，S1 结构级/S2 事实残留/S3 组织性只标记 → save_report 落盘，聊天只发要点）；Phase 3 确认（ask_questions：范围/歧义裁定/高影响项）；Phase 4 修复（基准文件不动→先修同层→最后重写最滞后的总纲；Grep 旧值残留必为 0；汇报改动清单）。场景路由：全面校准/定向校准/只诊断不修/修后复检。铁律：不动 正文/、追踪/、原著/拆书/（只标记）；歧义必问；修后必验。
- `references/checklist.md`：核对清单——第 0 节盘点清单（大纲体系纵向+关联横向+同人加读原著侧，_progress.json 判定已确认区）；第 1 节分层同步（总纲↔卷纲↔分章规划↔细纲 + 文件内部自洽）；第 2 节跨文件事实（已砍设定 Grep 残留/字数互算/主角事实/书名/关键锚点四方一致/题材定位对齐/preferences 冲突/时间线双轨）；第 3 节组织性（S3 只标记）；第 4 节严重级判定 + 诊断报告表格格式（基准值必须注出处，两派并存标「⚠ 待用户裁定」）。
- 与用户实际案例对齐：案例中的「大纲.md 停在旧决策（30万/5段/旧锚点）vs 卷纲+分章规划自洽群（23万/62章/三步塔锚点）」「考核线已砍残留于时间线对比+题材定位」「18岁 vs 17岁」「书名两处确认文件一致以文件为准」全部被清单覆盖；目录重组类需求（细纲平铺/卷二占位）走 S3 标记+说明需用户手动配合（Agent 无删除工具）。

### 验证

- `pnpm -r typecheck` 通过；`pnpm build`（web）通过。
- 路由实测（tsx 运行 classifyIntent）：校准一下大纲/一致性检查/大纲滞后/同步设定/矛盾排查/重构大纲 → calibrate；写第3章→write、继续同人→fanfic、审稿→review、润色→polish 互不误伤。
- 技能发现实测（SkillLoader）：story-calibrate 出现在 L1 目录（20 个技能），SKILL.md 正文 2528 字 + references/checklist.md 加载正常。
- 模式定义实测：getMode('calibrate') 14 工具（含 Write/Edit/Grep/save_report/ask_questions）、defaultPanel=report、approval=rewrite-only；MODE_DEFS 共 9 模式。

## 22. 免费模型配置（免费池多账号 key 轮询，429 自动换 key 不中断对话）

- 需求：日日新等免费端点免费但高频 429「使用的人数太多」——同一 baseURL 下配置 ≤10 个不同账号的 key，任一 key 触发限流自动切换下一个重试、全程轮询不中断对话；模型切换下拉显示 FREE 标签。

### 22.1 数据模型与服务端

- `apps/server/src/settings.ts`：`ModelProvider` 新增 `kind?: 'standard' | 'free'`（未配置=standard 兼容历史）与 `apiKeys?: string[]`（免费池 key 清单 ≤10；`apiKey` 仅首个 key，兼容旧逻辑）。`getActive()` 展开透传，无需改动。
- `apps/server/src/routes/settings.ts`：新增 `sanitizeKeyPool()`——主 key 优先、去空白去重、上限 10（放宽为 4-1024 长度 + 无空白 + 不重复，避免误杀特殊字符 key）；`sanitizeProvider()` 按 kind 归一化——kind='free' 且池**≥2 个 key**（不足 2 个无法轮询）才保留免费池，否则降级 standard 并清池，apiKey 同步为池首。
- `packages/shared/src/index.ts`：`ServerConfig.models` 项加 `free?: boolean`（前端渲染 FREE 徽标）。
- `apps/server/src/routes/api.ts`：GET /api/config 的 models 每项加 `free`（kind==='free'），免费池 label 附「（免费×N）」；`apps/server/src/routes/chat.ts`：modelOverrides 透传 `apiKeys`，日志标注 `/免费池×N`。

### 22.2 模型调用层 429 故障转移（核心）

- 新增 `packages/agent-core/src/failoverFetch.ts` `createFailoverFetch()`：自定义 fetch 包在 `normalizingFetch` 外层，**按响应状态码轮询换 key**——恒尝试池首 key，429/503 则头尾轮换（下降权）再试；成功即停（该 key 保持池首，下次优先）；整池一轮全限流 → 轮间等待后第二轮（默认 maxRounds=2、retryDelay 300ms、roundDelay 1500ms），仍失败返回最后限流响应。key 经 Authorization 头注入（覆盖 createDeepSeek 单 key 头），模型构造/请求体全程不变，SDK 视角一次调用——对话不中断。
- `packages/agent-core/src/agent.ts`：chatStream 中 `apiKeys` 池 ≥2 时启用 failover（否则原样 normalizingFetch）；`describeModelError(error, freePool)` 新增免费池分支文案——整池 429 明确「各账号共享限流，已自动轮询重试，稍后回复「继续」续跑」；401 分支提示核对池内失效 key。

### 22.3 配置 UI 与模型切换标签

- `apps/web/src/panels/SettingsPanel.tsx`：配置模式三选一（官方模板/自定义/免费池）；免费池显示「API keys 每行一个，最少 2 个、最多 10 个」textarea（保存时解析去重截断、少于 2 个拒绝保存）、hint 说明 429 自动切换不中断；列表项免费池显示 `FREE×N` 徽标（settings-free-tag）；编辑免费池回填 textarea。
- `apps/web/src/chat/ChatComposer.tsx` + `ChatPanel.tsx`：models 项加 `free?: boolean`；选中免费池模型时输入栏显示 FREE 徽标（model-free-tag，title 说明多 key 自动轮询）。
- `apps/web/src/styles/04-settings-modal.css` + `08b-composer-plus.css`：`.settings-free-tag` / `.settings-textarea` / `.model-free-tag` 样式。

### 22.4 杂项修复：免费池 radio 选中无效

- 根因：`SettingsPanel.tsx` 免费池 radio 的 `onChange` 只写了 `setMode('custom')`，漏写 `setKind('free')` → 点击后 kind 仍为 'standard'，界面停在自定义页且「自定义」radio 仍保持选中，表现为"点了没反应"。修复：三个配置模式 radio（官方/自定义/免费池）onChange 均显式设置 mode+kind 二元组（自定义→standard、免费池→free），反向切换不再残留。

### 验证

- `pnpm --filter @story-studio/agent-core --filter @story-studio/server --filter @story-studio/web typecheck` 通过。
- failoverFetch 单元脚本实测（tsx，5 场景 6 断言全过）：①key1 429 → 换 key2 成功且 key2 前移；②全池限流两轮 → 返回 429；③3 key 池前两个限流 → key3 命中；④无限流直通；⑤503 同样触发轮换。

## 23. 同人卷详情细纲误判「本卷细纲还没有生成」（卷目录内文件识别失败）

- 现象：`大纲/第1卷_第一卷/` 下已有 `卷纲.md` 与 `细纲_第001章.md`…，卷纲正常显示，但细纲区显示「本卷细纲还没有生成」。
- 根因：后端 `fanfic.ts listMdFiles()` 对子目录内文件返回的 `name` 带目录前缀（`第1卷_第一卷/细纲_第001章.md`）；前端 [FanficPanel.tsx](../apps/web/src/panels/FanficPanel.tsx) 的 `chOf()` 用 `^` 锚定正则直接匹配 `f.name` → 全部过滤掉。卷纲不受影响是因为它走 `f.path` 精确匹配。
- 修复：`chOf()` 匹配前先经 `baseName()` 取「/」后文件段（同时兼容旧平铺 `细纲_第NNN章.md`）；细纲勾选行的章号提取（原 `^细纲_(\d{1,4})章` 直配 `f.name`）改为复用 `chOf(f.name)`。
- 验证：`tsc --noEmit -p apps/web/tsconfig.json` 通过；按卷目录结构（volDir=`大纲/第1卷_第一卷`、文件 `细纲_第001..007章.md`、范围 1-62）核对过滤与排序均正确。

## 24. 同人卷详情：细纲确认与「追加细纲」职责拆分 + 卷纲按钮文案 bug

- 需求：勾选细纲点「✓ 确认已完善」只应上报确认结果，不应顺带让 AI「继续生成后续批次细纲」（每次确认都触发一次续写，语义错误）；「生成下一批」应是独立的显式按钮。
- 改动（`apps/web/src/panels/FanficPanel.tsx`）：
  - `confirmChapters()`：移除 `confirmed` 参数（确认走该函数、取消确认走行内 ✕），确认后仅发送「已确认第 X 章细纲已完善（_progress.json 已记录）」入库告知，不再附带续写指令。
  - 细纲区底部 CTA 新增「＋ 追加细纲（AI 生成下一批）」按钮：发 Agent 指令「对照 卷纲.md 从已有细纲的下一章继续分批生成（不覆盖已确认章节）；全部生成完提示可进入创作」。
  - 修复「✦ AI 生成本卷卷纲与细纲」按钮提示中 `${volDir}` 未插值（误用单引号字符串）问题，改为模板字符串。
- 验证：`tsc --noEmit -p apps/web/tsconfig.json` 通过。

## 25. 修复 opencode 网关报「Request is missing x-opencode-session」（Agent 全链路 API 调用失败）

- 需求：Agent 运行即失败，日志 `AI_APICallError: Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently`。根因：`.env` 的 baseURL 指向 opencode 网关（`https://opencode.ai/zen/go/v1`），该网关 2026 起强制要求请求携带会话级稳定的 `x-opencode-session` 头（路由/提示词缓存用）+ 自定义 User-Agent（反滥用监测），缺失即整轮报错。
- 新增 `packages/agent-core/src/gateway.ts`：`isOpencodeGateway()`（识别 opencode.ai 主机）+ `opencodeGatewayHeaders(baseUrl, sessionId?)`——仅对 opencode 域名注入 `x-opencode-session`（缺省生成随机会话 id）与 `user-agent: story-studio-agent/1.0`，其他网关/官方端点返回 undefined 无感。
- 接入点（全部 `createDeepSeek` 构造处加 `headers`）：
  - `agent.ts`：`ChatStreamOptions` 新增可选 `sessionId`；主 Agent 传会话级稳定 id（同一对话各步一致 → 提示词缓存命中）。
  - `apps/server/src/routes/chat.ts`：`chatStream({ sessionId: activeSession.meta.id })` 透传会话 id。
  - `router.ts`（LLM 意图兜底分类）与 `reviewers.ts`（审稿子 Agent）：按调用/整批生成随机会话 id。
- 验证：`packages/agent-core` 与 `apps/server` `tsc --noEmit` 通过。


