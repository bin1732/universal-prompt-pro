# references/agent-skills-spec.md — Agent Skills 规范对齐说明

> 本 skill 遵循 Agent Skills 规范（agentskills.io）。本文说明 frontmatter 字段与渐进披露用法，供宿主正确加载、用户理解结构。

## frontmatter 字段

| 字段 | 值 | 说明 |
|------|-----|------|
| `name` | `universal-prompt-pro` | 唯一标识；安装目录名须与其一致（见 installation-guide.md） |
| `description` | 见 SKILL.md | 触发依据：能力 + 触发词 + 负面触发词（"不用于…"） |
| `version` | 1.0.1 | 版本号 |
| `compatibility` | Node ≥14.18 / 联网工具 ≥18 / 零外部依赖 / Windows·Linux·macOS | 环境要求 |
| `metadata` | language: zh-CN / type: prompt-engineering | 附加元信息 |

## 渐进披露（四阶段）

1. **发现（Advertise）**：宿主只读 `name` + `description`（约 160 token），判定是否需要触发。
2. **激活（Load）**：触发后读 SKILL.md 全文（约 85 行），获取 L0-L5 流程骨架与按需读取指引。
3. **参考（References）**：按 SKILL.md 中的"需要时读 references/ 下对应文档"指引，按当前阶段加载对应文档（环境矩阵/模板/技术/评分/安全/专家人设/引擎清单等）。
4. **执行（Scripts）**：需要确定性计算时调用 scripts/ 引擎（安全扫描/构建/评分/版本化/评测门禁/联网核验）。

## 目录约定

- `SKILL.md`：流程骨架 + 阶段指令 + 按需读取指引（完整细节不常驻）。
- `references/`：规则文档与数据（环境矩阵/模板/技术/评分/安全/词库/评测用例/专家人设/引擎清单/安装指南等）。
- `scripts/`：可执行引擎（Node ≥14.18，零外部依赖）。
- `data/`：运行时自动创建的私有数据（版本快照/画像/检索缓存/经验库），随使用产生，不随 skill 分发。

## 触发纪律

- description 中的触发词命中才触发；负面触发词场景（普通写作/翻译/摘要、代码生成、非提示词工程类请求）不触发，走宿主常规能力。
- 简单单步请求（如"把这句话改顺"）不强制触发——宿主能直接做就不抢。
