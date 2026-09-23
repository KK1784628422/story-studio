# 2.0 提示词方法论 — 电影摄影级人物头像

> 最高原则：**Prompt 是摄影师工作笔记（Photographer's Notes），不是物体清单（Object List）。**
> 你写的不是「画面里有什么」，而是「摄影师为什么这样拍、把注意力放在哪里、决定不拍什么」。
> 电影感来自克制，不是堆叠；拍的是 Moment（瞬间），不是 Object（物体）；Discover, not Present。

## 一、输入端（继承 1.0，全部保留）

### 角色卡字段

- 基本信息：姓名、性别、年龄段、时代背景（朝代/年代）、身份阶层
- 外貌特征：体型、脸型、肤色、眼神、发式、标志性特征（疤痕/痣/随身物）
- 性格关键词（须转化为可视化的神态与动作，不直接写形容词进 prompt）
- 标志物（服装、道具、随身物件——优先级最高的画面元素）
- 处境/场景（决定 Scene 段怎么写）
- 人物弧线（用于一致性系列或成长阶段系列）

### 五规则（2.0 全保留，融入决策与组装）

1. **彩蛋规则**：把设定集里的伏笔、标志物、重复看点转译成画面细节（旧烫疤、药渍袖口、左臂试药布带），prompt 里不解释含义，只呈现视觉事实。
2. **反差规则**：背景与人物状态对位——乱世中的静定点、劫掠后的整洁小院、风暴中心的不动者。
3. **可视化规则**：性格形容词禁止直接入 prompt。「极致理性」→ 目光越过观者像在称量 + 指尖搭算盘。
4. **色调对位规则**：同一作品多角色色盘必须可区分（男冷灰蓝 vs 女暖土绿）。
5. **时代考据规则**：服饰、道具、发型须符合作品时代，不出现后世器物。

## 二、静默摄影决策（六步，结果进中文对照版，过程不占聊天）

### 决策 1 · 摄影主题

不是分析物体，而是分析**情绪主题**：孤独、等待、坚守、锋利、温暖、疏离、敬畏……
一句话定调：这张头像拍的是「____」。

### 决策 2 · Character DNA（原型选型 + 反差设计 + 骨相规格）

读 `archetypes.md` 选一个原型作底稿（可两个混血），然后结合角色卡重写为英文段落：

- **反差感靠气质与五官的反差，不靠妆容**：Cool temperament with unexpectedly soft facial features；
- **辨识度 > 完美脸**：natural asymmetry / expressive eyes / memorable because of quiet individuality；
  禁 perfect face、flawless、doll face（直接把模型推向 AI 脸）；
- **比例真实**：lean / athletic / balanced from years of ____（练武/劳作/行医）；禁 tiny waist、oversized eyes；
- **服装讲功能与磨损，不讲华丽**：材质、新旧、补丁、污渍——用磨损细节讲出身（彩蛋规则落点）。

**骨相规格（防幼态脸/防 AI 网红脸的核心武器，人物成年头像必选一套融入外貌段）**——写骨相不写美丑形容词：

女性（古典骨相，全肯定句，按角色微调措辞）：

```text
Her face is built on classical Chinese bone structure. The three horizontal
thirds of her face are close to equal, the mid-face and lower face fully
developed, the chin a proper length. The face is lean, with the cheekbone
and jaw reading clearly beneath the skin. Narrow high cheekbones and a
subtly defined brow bone give the face real shadow structure. Long narrow
almond eyes with a level outer corner. Straight soft sparse brows, a low
subtle nose bridge, a straight fine nose with a small refined tip. A small
mouth with a clearly defined lip peak, a high crown and a smooth full
forehead.
```

男性（在女性版基础上换骨架量感）：

```text
His face is built on classical Chinese bone structure. The three horizontal
thirds are close to equal, the mid-face and lower face fully developed. The
face is lean with the cheekbone and jaw reading clearly beneath the skin,
a clean sharp jawline tapering to a defined chin. His features sit
generously far apart. Long narrow eyes with a level outer corner, straight
sparse brows, a straight nose with a refined tip, a mouth of average size
with a defined lip peak. Weathered skin with natural texture, no retouching.
```

⚠ 骨相三禁词（写了必崩幼态/偶像脸）：`large eyes`、`full lips`、`gentle`（gentle 会被读成微笑，一笑苹果肌顶起全脸幼态化）。要表达反面就写骨相事实：「不要婴儿肥」→ the cheekbone and jaw read clearly beneath the skin。

### 决策 3 · Attention（灵魂模块）

人物此刻把注意力放在哪里——**注意力对象 = 视觉锚点 = 画面最亮处**：

- 看标志物 = 回忆/羁绊；看远方 = 等待/向往；看光 = 希望；看手中活计 = 专注/自省；
- 多数角色**不看镜头**：目光落在注意力对象上或越过观者（He does not notice the camera）；
- 气场型角色可直视观者，但神态必须具体（neither servile nor fearful），
  不写成 pose 感的 looking at camera。

### 决策 4 · Story Moment

这一秒**刚刚**发生了什么——写「刚刚/前一秒」，不写状态：「指尖刚停在一颗没推完的算珠上」
优于「他在算账」。「什么都没发生」也是强瞬间。给动机暗示但不说破。

### 决策 5 · Photography Strategy

- 焦段 85mm（人像甜区）；机位 Eye Level（气场型角色可低 10°）；
- 人物占比 **30-50%**，写具体百分比进 prompt（occupies roughly forty percent of the frame）；
- **off centre**（不居中，显式写 placed off centre）；
- **唯一可信光源**（motivated lighting）：光先照空间/悬浮物/注意力对象，最后才照脸；
  最亮处不一定是脸，必须点名最亮处是什么；
- 背景三层：前景静锚点（反差规则的「静」）→ 中景人物 → 背景氛围（「乱」）；
- 空气感：光里要有悬浮物（尘、草屑、花瓣、雪）增加体积感。

### 决策 6 · Visual Hook

第一眼 → 第二眼 → 第三眼的视线路径：第一眼 = 最亮处（= 注意力对象），第二眼 = 眼神/神态，
第三眼 = 环境/时代。停留来自视觉反差，不是感官刺激。

## 三、九段组装（英文摄影笔记式散文，300-450 词）

```
1. Intent               第一句定调：This image is approached as a quiet cinematic portrait
                       rather than a beauty illustration / costume drama still / fantasy artwork.
2. Hierarchy            谁是主角、占比具体百分比、off centre
3. Attention            她/他此刻看哪里、为什么
4. Photography Strategy 85mm / eye level / 唯一光源与最亮处 / 背景三层
5. Visual Hook          第一眼锚点（最亮处点名）
6. Photographer's Notes Observe / Trust / Leave 句式选 3-5 句
7. Director's Observation 收尾情绪段：2-4 句现在时观察（环境拟人、时代与人物对位）
8. Scene Details        五要素：Location / Time / Weather / Moment / Human Scale
9. Rendering Constraints + 负向压缩句（见第四节）
```

### Scene 五要素（写「世界正在发生什么」，不写「世界里有什么」）

```
Location    半塌的官道驿站
Time        唐代，清晨
Weather     薄雾贴着残墙
Moment      第一缕冷光刚爬上纸窗
Human Scale 驿道尽头一队无声的流民正在经过
```

### 灵魂句式库（段 6-7 选句，勿全用）

```
Observe her attention before observing her beauty.
Observe the light before observing the face.
The portrait feels like the camera has accidentally witnessed a private moment.
He does not notice the camera.
Nothing feels posed. Nothing feels performative.
The landscape remains indifferent to human presence.
The entire room seems to hold its breath.
Avoid visual spectacle. Leave empty space. Leave ambiguity. Trust natural light.
Let the viewer slowly discover the image.
```

### 色调与明度定位（融入段 4/7/8）

**两到三个主色 + 人物明度定位**（不是五个文艺色词的平铺——限制色彩 ≠ 低饱和，是少数几个**浓颜色**承担画面）：

```text
Only two colours exist here: ink green and cold white.
Her robe is the lightest value anywhere in the picture.
```

- 主色 2-3 个（来自光与空气，不来自物体）；同作品多角色按色调对位规则错开主色组合；
- **人物必须有明度定位**：人物是全图最亮（白衣/受光）或与背景构成明度对比（亮背景中的暗色人物），显式写进 prompt——这是把色彩纪律变成可执行指令的关键；
- 最亮处点名（决策 5 已定）与人物明度定位一致：光先照注意力对象，人物衣袍/面部按定位排明度序。

## 四、负向处理（豆包适配）

豆包无独立负向字段 → 压缩 2-4 句融入正向结尾：

```
The image must not look like CGI, game art, digital painting or a promotional poster.
Avoid HDR, oversaturated colors, plastic skin, theatrical lighting and centered heroic composition.
The result should feel like restrained cinematic photography captured on real film,
with soft highlights, low contrast and natural atmosphere. No text, no watermark.
```

人像追加强调（按需选 1 句）：Avoid beauty-filter skin, doll face, forced smile and direct flash lighting.

## 五、禁用词清单（正向一律不得出现，出现即打回）

```
8K, 4K, masterpiece, best quality, ultra detailed, ultra realistic, hyper detailed,
HDR, epic, amazing, stunning, breathtaking, award winning, trending on artstation,
sharp focus, insane detail, extremely detailed, high resolution, photorealistic（单独作为标签时）,
perfect face, flawless, doll face, tiny waist, oversized eyes
```

⚠ 1.0 的固定质量词库（masterpiece quality / highly detailed / 8K resolution / volumetric lighting 等）
在 2.0 **全部废弃**——这些词把模型推向 CG 宣传图数据集。电影感需要把画面「压下来」，不是「拉上去」。

## 六、输出三件套（继承 1.0 习惯）

1. **英文主提示词**：九段摄影笔记式散文，300-450 词；
2. **中文对照版**：逐模块对应（六决策 → 九段落点），供用户微调；
3. **模块映射表**：`决策 → prompt 落点` + 彩蛋清单（彩蛋 → 对应设定原文）。

## 七、自检清单（调用 webai_draw 前必过，任一不过打回重写）

- [ ] 禁用词零命中
- [ ] 三层结构齐：Intent（这是什么、不是什么）/ Hierarchy（占比量化）/ Restraints（克制约束）
- [ ] Scene 五要素齐（Location/Time/Weather/Moment/Human Scale）
- [ ] 占比具体百分比 + off centre
- [ ] 光源唯一可信，最亮处已点名，最亮处不一定是脸
- [ ] 主色 2-3 个 + 人物明度定位已写（最亮/与背景构成明度对比）
- [ ] 骨相模块已融入（成年人物头像必选一套），骨相三禁词零命中
- [ ] 性格形容词零直写（可视化规则）
- [ ] 负向压缩句在结尾
- [ ] 角色卡硬设定全部遵守（时代考据 + 彩蛋落位）
- [ ] 词数 300-450

## 八、示例（林砚秋 · 2.0 版，与 1.0 novel-character-prompt 示例 A 同人物可直接对比）

```text
This image is approached as a quiet cinematic historical portrait rather than a costume
drama still or a fantasy illustration.

A lean young scholar-strategist of the Tang Dynasty era, occupies roughly forty
percent of the frame, placed off centre at a scarred wooden table inside a half-ruined
post-station. His attention rests on a worn wooden abacus: one ink-stained fingertip has
just stopped on a bead he has not yet pushed. His gaze passes slightly beyond the viewer,
weighing something no one else in the room can see.

Cold early-morning light slants through a cracked lattice window — the only light source.
It touches the floating dust first, then the abacus beads, then the old burn scar crossing
the web between his thumb and forefinger, and only last his face. The brightest thing in
the frame is the pale beam striking the table edge, not his skin.

His ash-brown hair sits in a simple scholar's topknot fixed with a plain wooden pin, a few
loose strands untouched. The grey-brown robe is washed thin and discreetly patched at the
cuffs, bound with a plain cloth sash — the dress of a refugee scholar, elegant through
posture rather than fabric. Realistic lean proportions, natural asymmetry in his features,
calm deep-set eyes carrying quiet intelligence and hidden sharpness, thin firm lips.
He does not notice the camera. Nothing feels posed.

Location: a half-ruined roadside post-station on the Central Plain. Time: early morning.
Weather: thin fog clinging to broken walls. Moment: the first cold light has just reached
the abacus. Human scale: beyond the half-open door, a silent line of refugees moves along
the war-torn road — broken city walls, distant smoke columns — while he stays perfectly
still, a fixed point in the storm.

The palette blends ash grey, ochre, muted ink-brown and cold blue-grey; color comes from
the fog and the light rather than from objects. Observe his attention before observing
his face. The room seems to hold its breath. Avoid visual spectacle. Leave empty space.
Trust natural light. Let the viewer slowly discover him.

The image must not look like CGI, game art, digital painting or a period-drama poster.
Avoid HDR, oversaturated colors, plastic skin, theatrical lighting and centered heroic
composition. The result should feel like restrained cinematic photography captured on
real film, with soft highlights, low contrast and natural atmosphere. No text, no watermark.
```

要点对照（与 1.0 示例 A 同人物）：算盘从「身份道具」升级为「注意力对象 + 最亮处」；
虎口旧烫疤保留（彩蛋规则）但由光「最后才照到」；乱世背景压缩进 Human Scale 一句；
质量词全部替换为 Photographer's Notes 与负向压缩句。
