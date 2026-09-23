---
name: novel-character-prompt
description: "将小说角色卡转化为结构化生图提示词（英文主提示词 + 中文对照版 + 结构映射表），七段式人像模板，适配 GPT-Image / Seedream / 豆包等生图模型。触发：生成人物画像提示词、角色立绘提示词、同脸一致性系列、人物视觉设计。"
---

# 小说人物画像提示词模板（Novel Character Portrait Prompt）

将小说角色卡转化为**结构化生图提示词**，适配 GPT-Image2 / Seedream / 豆包等模型。输出为「英文主提示词 + 中文对照版 + 结构映射表」三件套。

## 输入：角色卡

期望用户提供以下字段（缺项时按题材与人设合理补全，并在映射表中标注哪些是推断项）：

- 基本信息：姓名、性别、年龄段、时代背景（朝代/年代）、身份阶层
- 外貌特征：体型、脸型、肤色、眼神、发式、标志性特征（疤痕/痣/随身物）
- 性格关键词（需转化为**可视化的神态与动作**，不直接写形容词进 prompt）
- 标志物（服装、道具、随身物件——优先级最高的画面元素）
- 处境/场景（初遇、日常、高光时刻等，决定环境块怎么写）
- 人物弧线（用于一致性系列或成长阶段系列）

## 七段式模板（核心结构）

按顺序组织 prompt，每段只做一件事：

| 段 | 作用 | 写法要点 |
|---|---|---|
| 1. 主体开场 | 风格定位 + 人物身份 | `Ultra-realistic cinematic historical portrait of a [体型] [身份], [时代]`，一句话锁死画质、题材、年代、阶层 |
| 2. 外貌神态 | 五官 + 性格可视化 | 眼神写「目光的性质」而非形容词堆砌；加一个**标志性小动作**（指尖搭算盘/稳手分药），把性格词变成画面 |
| 3. 发饰服饰 | 发式 + 服装 + 标志物 | 服装写材质、新旧、补丁、污渍——**用磨损细节讲出身**；标志物必写且给特写级描述 |
| 4. 光线 | 主光方向与质感 | 冷光=理性/乱世，暖光=人情/坚守；光里要有悬浮物（尘、草屑、花瓣）增加体积感 |
| 5. 环境氛围 | 背景叙事 | 一个「乱」的背景 + 一个「静」的前景锚点，形成人物与时代的对位；环境必须与角色处境呼应 |
| 6. 色调 | 3-5 个颜色词 | 颜色即人物气质：烟灰赭石=冷静谋士，土赭艾草绿=温暖医者。**多角色同一作品时色调必须互相错开** |
| 7. 风格质量词 | 固定收尾 | 通用质量词 + 1-2 个自定义氛围词（如 `quiet-storm ambiance` / `steadfast-ember ambiance`），给每个角色一个专属氛围词 |

## 设计规则

1. **彩蛋规则**：把设定集里的伏笔、标志物、重复看点转译成画面细节（旧烫疤、药渍袖口、左臂试药布带），prompt 里不解释含义，只呈现视觉事实。
2. **反差规则**：背景与人物状态对位——乱世中的静定点、劫掠后的整洁小院、风暴中心的不动者。
3. **可视化规则**：性格形容词禁止直接入 prompt。「极致理性」→ 目光越过观者像在称量 + 指尖搭算盘；「手稳心细」→ 分拣药材的稳手特写。
4. **色调对位规则**：同一作品的多个主角/配角，段 6 的色盘必须可区分（男主冷灰蓝 vs 女主暖土绿），同框图与单人图才能形成视觉记忆点。
5. **时代考据规则**：服饰、道具、发型须符合作品时代（如唐代 → 幞头、圆领袍、烛台、卷轴），不出现后世器物。

## 输出格式（三件套）

每次生成必须包含：

1. **英文主提示词**（1-4 段连贯文本，段 1-7 依序展开，350 词以内为佳）
2. **中文对照版**（方便用户微调，逐段对应）
3. **结构映射表**：`原模板段位 → 本角色实现`，并附「埋进 prompt 的设定彩蛋」清单（彩蛋 → 对应设定原文）

## 衍生系列（按需生成）

- **同脸一致性系列（Lookbook 式）**：固定段 1-3 的人脸与标志物描述，只替换服装/发型/场景段，用于同一角色多状态。开头声明：`Same face as reference: [锁定描述]，12-panel grid (3 columns × 4 rows) showing the SAME person…`
- **成长阶段系列**：按人物弧线出 2-4 个阶段版本，段 1-2 面容锁定，段 3 服装随身份升级（村医女 → 军医制度主持者），段 6 色调随弧线渐变。
- **多人同框场景**：以关系节点为场景（如初遇、并肩作战），两个角色的段 6 色盘在同一画面中保持各自占比。

## 固定质量词库（段 7 基底，按需增删）

```text
Cinematic fine-art photography, ultra-detailed skin and fabric texture,
soft focus highlights, volumetric lighting, shallow depth of field,
masterpiece quality, highly detailed, 8K resolution, elegant composition,
desaturated cinematic color grading
```

## 参考示例

### 示例 A：林砚秋（男频主角 · 历史写实 · 冷调谋士）

要点：算盘对应「算账」人设；虎口旧烫疤=系统印记伏笔；静坐于乱世中心=主角定位；烟灰/赭石/冷蓝灰色盘。

```text
Ultra-realistic cinematic historical portrait of a lean, tall young Chinese
scholar living in the Tang Dynasty era, with refined composed
features, pale skin weathered by hardship, calm deep-set grey-black eyes
carrying quiet intelligence and hidden sharpness, and thin firm lips. He
gazes slightly past the viewer with a serene yet calculating expression,
the look of a man who always pauses a moment before speaking, one slender
ink-stained finger resting lightly against a worn wooden abacus beside him.

His ash-brown hair is tied in a simple scholar's topknot fixed with a plain
wooden hairpin, a few loose strands framing his face. His hands are elegant
and long-fingered, shaped by years of holding a brush; on his right hand,
an old burn scar crosses the web between thumb and forefinger, faintly
visible in the light. He wears a faded grey-brown old scholar's robe,
washed thin and discreetly patched at the cuffs, bound with a plain cloth
sash, the modest dress of a refugee scholar with no background and no wealth.

The scene is lit by cold early-morning light slanting through a cracked
lattice window, dust motes suspended in the beam, a dim oil lamp still
glowing on the table beside scattered maps, bamboo slips, brush and
inkstone. Behind him, through the half-open door, the blurred suggestion
of a war-torn Central Plain: broken city walls, distant smoke columns,
silent refugees on the road — the chaos of the era — while he stays perfectly
still at the center, like a fixed point in the storm.

The palette blends ash grey, ochre, muted ink-brown, and cold blue-grey
tones. Cinematic fine-art photography, Chinese historical realism,
period-drama aesthetic, subtle strategic-genius aura, ultra-detailed fabric
weave and skin texture, soft focus highlights, volumetric lighting, shallow
depth of field, masterpiece quality, highly detailed, 8K resolution,
restrained masculine elegance, tragic-historical atmosphere, elegant
composition, desaturated cinematic color grading, quiet-storm ambiance.
```

### 示例 B：沈杏（女频女主/配角 · 历史写实 · 暖调医者）

要点：与示例 A 形成**色调对位**（暖土绿 vs 冷灰蓝）；药笥不离身、药渍袖口、左臂试药布带均为设定彩蛋；「劫掠后狼藉 vs 扫净的小院」=反差规则。

```text
Ultra-realistic cinematic historical portrait of a young Chinese village
healer's daughter living in the Tang Dynasty era, with a lean
sun-touched figure, weather-tanned skin, clear sharp almond eyes full of
quiet stubbornness, and a resolute, unflinching expression — the steady
gaze of someone who has seen life and death trade places many times. She
gazes directly at the viewer, neither servile nor fearful, her lips pressed
with calm determination, both hands steady as she sorts dried herbs across
an open wooden box, her fingertips resting on a bundle of mugwort.

Her dark hair is tied back in a practical working knot wrapped with a plain
cloth strip, a few loose strands stuck to her damp temple. Her sleeves are
pushed up to the elbow, the faded cuffs stained with dark green and amber
medicine marks that no washing ever fully removed; a small neat bandage
wraps her left forearm — she tests every new remedy on herself first. She
wears a coarse hemp dress in faded indigo and undyed beige, practical and
patched at the knees, a worn wooden medicine chest slung at her side with
frayed rope, its corners rubbed smooth by years of travel.

Warm late-afternoon light falls through the open door of a humble village
room, catching motes of dust and dried herb fragments in the air; beside
her hang bundles of herbs, a small clay mortar, rolled hemp bandages and a
kettle of boiled water. Beyond the doorway, the muted aftermath of a looted
salt-farmers' village — trampled fences, scattered belongings — yet her
small courtyard is swept clean, the one orderly place in the chaos, where
the wounded are being carried in on door planks.

The palette blends earthy ochre, mugwort green, medicine-brown, warm beige
and faded indigo tones. Cinematic fine-art photography, Chinese historical
realism, period-drama aesthetic, the quiet dignity of a folk healer,
ultra-detailed fabric weave, herb and wood texture, soft focus highlights,
volumetric lighting, shallow depth of field, masterpiece quality, highly
detailed, 8K resolution, grounded feminine resilience, tragic-warm
historical atmosphere, elegant composition, desaturated cinematic color
grading with warm accents, steadfast-ember ambiance.
```
