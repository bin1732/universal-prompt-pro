# Template: SCHEMA（结构化抽取）

> 用途：需要严格结构化输出的抽取/转换任务。选型信号：需 JSON/结构化输出。
> 对应任务轴 A：抽取。兜底：FEWSHOT。

## 骨架

```
你是一个{抽取助手}。
从以下输入中抽取{目标字段}：
<input>
{待处理内容}
</input>

输出 JSON，schema 如下：
{
  "type": "字段名",
  "value": "值",
  "position": "位置或null"
}

规则：
- 字段不存在时 value 为 null（不要编造）
- 只输出 JSON，不要额外解释
- 无法解析的输入，输出 {"error": "reason"}

示例：
{"type": "date", "value": "2026-01-01", "position": 12}
```

## 使用要点
- schema 必须给字段类型 + 空值语义（防幻觉锚点）。
- 必须给"无法处理"的兜底输出（Robustness）。
- Few-shot 示例与 schema 一致（格式一致性）。

## 反例（不该用 SCHEMA）
- 输出只需文本/表格 → CO-STAR
- 分类任务（有限类别）→ FEWSHOT 更合适

## 环境适配
- 所有模型族通用；tool_call 平台可配 JSON schema 参数
- Claude 建议 `<json_schema>` 包裹；GPT 建议 Markdown code block
