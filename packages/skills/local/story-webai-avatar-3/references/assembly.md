# 转译组装（豆包化）— 从剧组语言到豆包接得住的指令

> MJ 转译层的七类对照，按豆包特性适配：豆包前置语言模型（全文均权、读得懂否定与长指令），
> 但**无独立负向字段、无参数尾**。所以：保留名词化硬资产（骨相/明度/百分比），去掉 MJ 参数，
> 负向融入正向结尾，允许有限否定句（豆包读得懂，但骨相段仍全肯定）。

## 一、七类转译对照（豆包化）

| # | 剧组语言（关系） | 豆包化转译（名词/事实） |
|---|---|---|
| 1 | 情绪：沉默、疏离 | 画面里的**动静**：Nothing in the frame moves except a few bamboo leaves drifting down and loose strands of hair lifting in the night breeze（全画面只有什么在动） |
| 2 | 否定：不看镜头/不要偶像脸 | **骨相事实替代**（读 bone-structure.md）+ She does not notice the camera（豆包可读否定，但骨相句内部仍全肯定） |
| 3 | 注意力：光先照剑不照脸 | **具体物体 + 明度定位 + 与皮肤比较**：A single ribbon of light rides the spine of the blade, the brightest thing in the frame, brighter than her skin |
| 4 | 相对占比：人占三分之一 | **具体百分比 + off centre**：she occupies about twenty-eight percent of the frame, placed off centre |
| 5 | 限制色彩 | **两三个浓颜色 + 人物明度定位**：Only two colours exist here: ink green and cold white. Her robe is the lightest value anywhere in the picture（限制色彩 ≠ 低饱和！） |
| 6 | 摄影哲学句 Observe/Trust | 豆包读得懂——**保留**（MJ 会砍，豆包不砍，这是 3.0 对 2.0 的加强：哲学句继续起作用） |
| 7 | 意图声明 | **保留**（豆包 LLM 消化 Intent 为氛围倾向；MJ 必删，豆包不删） |

## 二、组装顺序（九段，300-450 词摄影笔记式散文）

```
1. Intent               第一句定调：This image is approached as a quiet cinematic portrait
                       rather than a beauty illustration / costume-drama still / fantasy artwork.
2. 主体与情境           谁·在哪·做什么（第一句后的头几句必须能独立成图——把后文全删，
                       前三句仍能出对的图）
3. 环境与光             环境、光从哪来、最亮处点名、光先照什么最后照什么
4. 动态事件             什么正在动（叶/发/蒸汽/尘/雪——最常被漏，决定画面活不活）
5. 人物骨相与造型       bone-structure.md 全肯定句 + 服装形制逐字（交领右衽/材质/磨损彩蛋）
6. 表情与视线           Attention 模块产出（看不看镜头、看哪、为什么）
7. 镜头                 85mm / eye level / 占比具体百分比 / off centre / 摄影机在环境内外
8. Scene 五要素 + 收尾  Location / Time / Weather / Moment / Human Scale
                       + Photographer's Notes 3-5 句 + Director's Observation 2-4 句
                       + 主色与明度定位句
9. 负向压缩句（融入结尾，见第四节）
```

## 三、硬纪律

1. **第一句独立成图**：把后 2/3 删掉，前三句必须仍能出对的图（主体+环境+动作齐全）；
2. **动态事件必有**：全画面「只有 X 在动」的句子必须出现一张；
3. **占比具体百分比 + off centre**：形容词不算数，写数字；
4. **明度定位显式**：最亮处点名 + 与皮肤比较（brighter than her skin）+ 人物明度定位（the lightest value anywhere）；
5. **骨相全肯定句逐字**：不得改写成近义词堆叠、不得拆散到失去结构；
6. **服装形制逐字复述**：cross-collared right over left 等专有形制不改写；
7. **同一视觉元素不描述两遍**（隔段重复摊薄权重）；
8. **敏感词扫查**（bone-structure.md 第六节词根表，正向全文交付前扫一遍）。

## 四、负向压缩（豆包无独立负向字段，融入正向结尾 2-4 句）

基础版（必带）：

```text
The image must not look like CGI, game art, digital painting or a promotional poster.
Avoid HDR, oversaturated colors, plastic skin, theatrical lighting and centered heroic
composition. The result should feel like restrained cinematic photography captured on
real film, with soft highlights, low contrast and natural atmosphere. No text, no watermark.
```

人像追加（按需 1 句）：Avoid beauty-filter skin, doll face, forced smile and direct flash lighting.
古装追加（按需 1 句）：Avoid modern clothing, urban elements and cosplay-style costume design.

## 五、禁用词清单（正向一律不得出现）

```
8K, 4K, masterpiece, best quality, ultra detailed, ultra realistic, hyper detailed,
HDR, epic, amazing, stunning, breathtaking, award winning, trending on artstation,
sharp focus, insane detail, extremely detailed, high resolution, photorealistic（单独作为标签时）,
perfect face, flawless, doll face, large eyes, full lips, gentle,
tiny waist, oversized eyes
```

## 六、三层自检（调 webai_draw 前必过）

### 审美层（不过 → 换场景，回 Step 3）

- [ ] 删掉故事，这张图还好看吗？
- [ ] 只有一种主感受？
- [ ] 美感发动机与同书上一张不同？
- [ ] 人物在环境里，还是像模特贴在背景前？

### 摄影层（不过 → 改模块，回 Step 5）

- [ ] 禁用词零命中（含骨相三禁词）
- [ ] Intent / Hierarchy / Restraints 三层齐
- [ ] Scene 五要素齐
- [ ] 占比具体百分比 + off centre
- [ ] 光源唯一可信，最亮处点名，最亮处不一定是脸
- [ ] 主色 2-3 个 + 人物明度定位
- [ ] 性格形容词零直写

### 转译层（不过 → 改措辞，回 Step 6）

- [ ] 前三句删掉后文仍能独立成图
- [ ] 动态事件句在
- [ ] 骨相全肯定句逐字融入、未拆散
- [ ] 服装形制专有名词逐字复述
- [ ] 同一视觉元素没有描述两遍
- [ ] 敏感词词根扫过（baby/teen/child/chubby/doll/wet/bare…）
- [ ] 年龄明写（She/He is NN years old）
- [ ] 负向压缩句在结尾
- [ ] 词数 300-450

## 七、示例骨架（月夜竹林女侠 · 豆包化，结构示范）

```text
[Intent] This image is approached as a quiet cinematic portrait rather than a
fantasy illustration or character artwork.
[主体情境] A 23-year-old Chinese swordswoman in a cross-collared right-over-left
white linen robe stands still on a mossy path inside a vast moonlit bamboo forest,
her head bowed, holding a straight double-edged Chinese jian horizontally before
her chest and studying the blade.
[环境与光] The frame is closed overhead by the interlocking bamboo canopy. Only
moonlight filters through, falling in cold silver beams between layers of leaves.
A single ribbon of light rides the spine of the blade, the brightest thing in the
frame, brighter than her skin. Only two colours exist here: ink green and cold
white. Her robe is the lightest value anywhere in the picture.
[动态事件] Nothing in the frame moves except a few bamboo leaves drifting down
and loose strands of her hair lifting in the night breeze.
[骨相]（bone-structure.md 女性版全肯定句，逐字）
[表情视线] Her gaze rests quietly on the blade and her head stays bowed. Her lips
are closed, her expression still and composed, as if remembering something. She
does not notice the camera.
[镜头] 85mm cinema lens at eye level, the camera positioned inside the forest,
she occupies about twenty-eight percent of the frame, placed off centre, countless
vertical bamboo trunks surrounding her.
[Scene+收尾] Location / Time / Weather / Moment / Human Scale 五句 +
Observe her attention before observing her beauty. + 负向压缩句。
```

（对比要点：这就是 Codex 用 midjourney-prompt 生成的那条的豆包化——去掉 `--ar --v --no`
参数尾，负向从 `--no` 转为结尾压缩句，其余硬资产全保留。）
