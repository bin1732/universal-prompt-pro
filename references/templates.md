# references/templates.md — 模板库索引（20 模板，按任务轴 A 选型）

> 用途：L3 模板路由。**P1-2 补全：20 模板全部可达（主路由 15 任务 + 子类路由 SUB_ROUTE），无死资产。**

## 路由规则
`if 任务 ∈ X 且 信号 ∈ Y → 模板 T`；未命中 → 回退 **CO-STAR**（通用安全网），并记录"未命中"到 usage log 供覆盖检查。
**双键路由**：`subtype` 优先（SUB_ROUTE，见 environment-matrix.md §4）→ 主路由 TEMPLATE_ROUTE → CO-STAR。

## 模板清单（20 个，全部可达）

| 模板 | 路由来源 | 适用任务轴 A | 选型信号 |
|------|----------|--------------|----------|
| RTF | 主路由：对话；子类：快速单步 | 全部·快速单步 | 简单、一次性、要快 |
| CO-STAR | 主路由：写作/分析；兜底 | 写作/分析/报告 | 专业文档、要结构完整 |
| RISEN | 主路由：代码 | 代码/多步项目 | 复杂、多步骤、有终点 |
| CRISPE | 主路由：创意；子类：品牌/个性化 | 创意/品牌 | 需要个性化、迭代创作 |
| COT | 主路由：数学/逻辑/调试；子类：代码·推理/调试 | 数学/逻辑/调试 | 需要推理链路；**o1/o3 类禁用** |
| FEWSHOT | 主路由：分类 | 抽取/分类/格式 | 输出格式必须稳定 |
| REACT | 主路由：agentic | agentic | 自主代理、需要工具循环 |
| RAG | 主路由：RAG | RAG | 有检索上下文、需引用 |
| VISION | 主路由：图像 | 图像 | 图像生成 |
| SOCRATIC | 主路由：教育 | 教育 | 教学场景 |
| DECISION | 主路由：决策 | 决策 | 需要结构化权衡 |
| SCHEMA | 主路由：抽取 | 抽取 | 需 JSON/结构化输出 |
| DIALOGUE | 子类：对话·多轮/客服 | 对话 | 多轮对话、身份语气一致 |
| AGENT | 子类：agentic·常驻 / 代码·常驻 | agentic | 常驻 agent 指令 |
| TOOLCALL | 子类：agentic·工具调用 / 代码·工具调用 | tool_call | 严格参数、机器可解析 |
| MCP | 子类：agentic·mcp | MCP | MCP server 工具描述 |
| PIPELINE | 子类：agentic·管道 | pipeline | 批量/分步处理 |
| BRAINSTORM | 子类：创意·头脑风暴/发散 | 创意子类 | 发散创意、数量优先 |
| SYNTHESIS | 子类：分析·多源综合/综合 | 分析子类 | 多源材料、冲突观点 |
| CLASSIFY | 子类：分类·有限类别/稳定分类 | 分类子类 | 有限类别、稳定分类 |

## 模板文件位置
各模板骨架放 `assets/templates/` 目录（20 个 .md 文件）。

## 完成状态（P1-2 全部完成 ✅）
- [x] 补齐 20 模板骨架文件（assets/templates/ 下 20 个完整模板，无存根残留）
- [x] 每个模板配"反例"（什么情况不该用）
- [x] 选型信号可测化（build-prompt.mjs TEMPLATE_ROUTE + SUB_ROUTE + assets/evals/build-cases.json 24 组合 + 子类用例测试）
- [x] **路由可达性断言（matrix-check.mjs）：每个模板文件必须被主路由或子类路由引用，无死资产**
