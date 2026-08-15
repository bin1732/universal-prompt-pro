# Template: CO-STAR（Context-Objective-Style-Tone-Audience-Response）

> 用途：专业文档、报告、写作、分析。选型信号：需要结构完整、面向特定受众的输出。
> 对应任务轴 A：写作、分析。兜底模板：通用安全网（路由未命中时回退本模板）。

## 骨架

```
# Context 背景
{任务背景：为什么做、相关材料、已知信息}

# Objective 目标
{明确的目标，一句话，可测量}

# Style 风格
{写作风格：正式/轻松/科技/营销…}

# Tone 语气
{语气：客观/鼓励/严肃…}

# Audience 受众
{目标读者：专业程度、背景}

# Response 输出
{输出形式：结构、格式、长度、要素清单}
```

## 使用要点
- Context 给足但不过载（无关背景是 Economy 扣分项）。
- Objective 可测量（"写一篇 500 字介绍" 优于 "写一篇好介绍"）。
- Response 段是 Specificity 维的主战场：格式、长度、要素必须显式。

## 反例（不该用 CO-STAR）
- 需要工具循环的 agentic → REACT
- 需要严格 JSON → SCHEMA
- 快速单步 → RTF

## 环境适配
- GPT：各部分用 Markdown 标题即可
- Claude：可用 `<context>...</context>` 包裹背景段
