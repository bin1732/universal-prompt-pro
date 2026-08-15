# Template: RTF（Role-Task-Format）

> 用途：快速单步任务。选型信号：简单、一次性、要快、无需多轮交互。
> 对应任务轴 A：全部·快速单步。兜底：CO-STAR。

## 骨架

```
你是一个{专业角色}。

任务：{一句话任务，动词明确 + 对象明确}。

输出格式：{格式/长度/要素约束，必须显式}。

规则：
- {必要约束 1-2 条}
- 如遇{边界情况}，按{兜底行为}处理，不要猜测。
```

## 使用要点
- 三步内完成：角色 → 任务 → 格式。不做多余展开（Economy 维）。
- 即使简单也必须保留输出格式约束（Specificity 底线——PromptEval 实测 specificity 是最常见失败）。
- 单任务原则：一个 prompt 只做一件事（多任务无优先级是 Clarity 扣分项）。

## 反例（不该用 RTF）
- 多步骤/有终点 → RISEN
- 需要专业文档结构 → CO-STAR
- 输出必须稳定 → FEWSHOT

## 环境适配
- Claude：任务与格式段可用 `<task>`/`<format>` XML 包裹
- GPT：Markdown 标题 + 短段落
- DeepSeek/豆包等：中文简洁，一行任务 + 一行格式

## 示例（before → after）
- Before："帮我优化一下这个函数"
- After："你是一个资深 TypeScript 工程师。请重构 getData() 为 async/await 并处理 null 返回。输出格式：Markdown 代码块 + 3 条变更说明，不超过 200 字。"
