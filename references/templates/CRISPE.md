# Template: CRISPE（Capacity-Role-Insight-Statement-Personality-Experiment）

> 用途：创意/品牌内容。选型信号：需要个性化、迭代创作、品牌声音。
> 对应任务轴 A：创意。兜底：CO-STAR。

## 骨架

```
# Capacity 能力
你具备{能力描述}，可以{能力边界}。

# Role 角色
本次扮演{角色}。

# Insight 洞见
关键洞见：{对主题的独特理解/切入角度}。

# Statement 陈述
主题陈述：{要传达的核心信息}。

# Personality 个性
表达个性：{品牌声音：正式/俏皮/大胆/克制…}，示例措辞：{1-2 个例句}。

# Experiment 实验
尝试方向：{3 个备选角度}。输出前两个方向各一版，标注差异。
```

## 使用要点
- 个性段（Personality）是关键差异化——品牌声音直接决定创意方向，示例措辞比形容词描述更有效。
- 实验段（Experiment）给迭代空间：多版本试稿让用户对比选择（而不是一次定稿）。
- 洞见段（Insight）是创意质量的杠杆：角度新颖 > 措辞华丽。

## 反例（不该用 CRISPE）
- 事实/抽取任务 → SCHEMA / FEWSHOT
- 需要严格格式的报告 → CO-STAR
- 发散数量优先 → BRAINSTORM

## 环境适配
- 所有模型族通用；Claude 可用 XML 包裹各段
- 创意任务避免过度约束（约束太多会扼杀多样性——Specificity 在这里是双刃剑，明确告知用户权衡）
