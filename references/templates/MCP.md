# Template: MCP（MCP 工具描述）

> 用途：MCP（Model Context Protocol）server 工具描述。选型信号：MCP 平台、需注册工具。
> 对应任务轴 A：agentic 子类。兜底：TOOLCALL。

## 骨架

```
工具名：{name}

描述：{一句话用途，必须含触发信号——像 SKILL 的 description 一样，决定宿主何时调用}

参数（JSON schema）：
{
  "type": "object",
  "properties": {
    "{参数名}": { "type": "{string|number|...}", "description": "{含义}" }
  },
  "required": ["{必填参数}"]
}

返回：{结构说明：成功/失败/错误格式}

错误处理：{失败时返回的错误码/信息约定}
```

## 使用要点
- 描述含触发信号（参考 anthropics/skills 的 description 优化方法论：20 条触发评测）。
- 参数 schema 严格（描述里写清每个参数的类型与含义）。
- 错误约定清晰：宿主能据错误码做决策。

## 反例（不该用 MCP）
- 非 MCP 平台 → TOOLCALL / 平台原生 schema

## 环境适配
- MCP 工具描述与宿主注册格式严格绑定
- 长描述会占上下文，保持精简（Economy 维）
