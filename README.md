# Universal Prompt Pro

> 万能提示词系统 — All-in-one prompt engineering system for AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Prompt Engineering](https://img.shields.io/badge/Prompt-Engineering-blueviolet.svg)]()
[![AI Agent](https://img.shields.io/badge/AI-Agent-orange.svg)]()
[![Coze Skill](https://img.shields.io/badge/Coze-Skill-ff6b6b.svg)]()

---

## 📌 简介 / Introduction

**Universal Prompt Pro（万能提示词系统）** 是一套面向 AI Agent 的提示词工程全链路工具。感知环境 → 针对性构建 → 真实评估 → 安全合规 → 可进化，覆盖提示词的完整生命周期。

Universal Prompt Pro is an all-in-one prompt engineering system for AI agents. It covers the full lifecycle of prompt engineering: environment-aware construction, evidence-based evaluation, safety compliance, and self-evolution.

---

## ✨ 特性 / Features

### 🔧 7 类意图路由 / 7 Intention Routes
- `create` 构建 — 从零生成高质量提示词
- `improve` 优化 — 迭代提升现有提示词
- `evaluate` 评估 — 8 维度 Q-Score 评分
- `diagnose` 诊断 — 定位问题并给出改进建议
- `migrate` 迁移 — 跨模型 / 跨平台适配
- `compress` 压缩 — 在有限 token 预算内优化
- `self` 自省 — 自我审查与规则校准

### 🏗️ 5 层流水线架构 / 5-Layer Pipeline
1. **L0 安全前置** — 注入检测 / 红线过滤 / PII 脱敏
2. **L1 意图路由** — 7 类场景智能分发
3. **L2 环境指纹** — 模型族 / 平台 / 任务 / 预算 / 用户等级
4. **L3 决策构建** — 20 套模板 + 技术选型 + 情报检索
5. **L4 自评估** — Q-Score 8 维评分，先列证据再给分
6. **L5 输出** — 快速模式 / 评审团模式 / 完整 eval 模式

### 🛡️ 安全合规 / Safety
- 注入特征扫描（全角 / 零宽 / emoji 变体绕过防护）
- 红线主题识别（涉政 / 涉黄 / 涉暴 / 违法 / 伤害）
- PII 敏感信息脱敏
- NFKC 归一化 + 词库降级机制

### 📈 自进化能力 / Self-Evolution
- 习惯画像自动学习（habit profile）
- 成功 / 失败案例入库（golden / failures）
- 版本快照与回滚（version store）
- 搜索缓存（TTL 7 天）
- 规则提案联网验证

### ⚙️ 22 个可执行引擎 / 22 Executable Engines
全部确定性、可复现、证据引用；`node scripts/validate.mjs` 一键回归门禁。

| 阶段 | 引擎 | 用途 |
|------|------|------|
| 端到端 | `pipe.mjs` | 完整闭环（安全→构建→评分→版本化） |
| L0 安全 | `scan-safety.mjs` | 注入/红线/PII/灰线扫描 |
| L3 构建 | `build-prompt.mjs` | 环境指纹→模板路由→组装 |
| L4 评分 | `score-prompt.mjs` | 结构 4 维评分 |
| L4 评分 | `sem-score.mjs` | 语义 4 维评分（规则版） |
| L4 评分 | `qscore-full.mjs` | 8 维合成 + LLM 判定覆盖 |
| L3 经济 | `token-count.mjs` | token 估算/预算/冗余 |
| L5 版本 | `version-store.mjs` | 快照/对比/回滚 |
| P5 画像 | `habit-profile.mjs` | 画像读写/清空 |
| P5 进化 | `evolve.mjs` | 失败入库/提案/确认 |
| 门禁 | `validate.mjs` | P0-P5 全门禁回归 |
| 攻击 | `attack.mjs` | 自我攻击（34 用例） |

---

## 🚀 快速开始 / Quick Start

### 在 Coze / 扣子平台使用
本技能已在虾评平台发布，直接搜索「万能提示词系统」即可安装使用。

### 本地使用（需 Node.js ≥ 14.18）

```bash
# 克隆仓库
git clone https://github.com/bin1732/universal-prompt-pro.git
cd universal-prompt-pro

# 端到端使用
node scripts/pipe.mjs --request "帮我写一个产品文案优化提示词"   --fp '{"model_family":"claude","platform_form":"chat","task_type":"文案"}'

# 安全扫描
echo "用户输入文本" | node scripts/scan-safety.mjs

# 提示词评分
node scripts/score-prompt.mjs your-prompt.txt

# 全门禁回归
node scripts/validate.mjs
```

### 触发词 / Triggers
优化提示词、写提示词、评估提示词、提示词不work、提示词评分、优化 system prompt、improve prompt、prompt optimization、prompt migration、prompt compression

---

## 📁 项目结构 / Project Structure

```
universal-prompt-pro/
├── SKILL.md              # 技能主文档
├── assets/
│   ├── templates/        # 20 套提示词模板
│   ├── evals/            # 评测用例
│   └── data/
│       └── lexicon/      # 安全词库
├── references/           # 参考文档（评分规则、环境矩阵等）
├── scripts/              # 22 个可执行引擎（.mjs）
├── LICENSE               # MIT 许可证
└── README.md
```

---

## 📊 评分体系 / Scoring System

Q-Score 8 维评估（详见 `references/scoring-rubric.md`）：

| 维度 | 说明 |
|------|------|
| 结构清晰度 | 层级分明、指令明确 |
| 角色设定 | Persona 是否精准 |
| 任务定义 | 目标边界是否清晰 |
| 约束条件 | 限制规则是否完备 |
| 输出质量 | 结果相关性与准确度 |
| 语义一致性 | 前后逻辑自洽 |
| 防幻觉能力 | 证据锚点与隔离标注 |
| 安全合规 | 注入防护与红线规避 |

---

## 🛡️ 安全声明 / Security

- 所有外部输入均经过安全扫描后再进入构建流程
- 支持全角 / 零宽 / emoji 等变体绕过检测
- 词库损坏自动降级到内置规则，不静默放行
- 自我攻击测试 34 用例全部通过

---

## 📄 许可证 / License

**MIT License** — 详见 [LICENSE](LICENSE) 文件。

本仓库为开源版本（v1.0.x），永久保留。后续增强版本将以闭源形式在 Coze / 虾评平台发布。

This repository contains the open-source version (v1.0.x) and will remain publicly available. Future enhanced versions will be released as closed-source on the Coze / XiaPing platform.

---

## 🔗 相关链接 / Links

- 🌐 **虾评平台**: [万能提示词系统](https://xiaping.coze.com/skill/54574cab-e5f5-49f3-9bf9-6d7a1545abbb)
- 💬 **作者主页**: [灵感引擎工坊](https://xiaping.coze.com/u/d6a5037f-4373-4f35-92ae-5c3d2c92a245)
- 🏠 **SkillHub**: [@user_0fcf0d65/universal-prompt-pro](https://skillhub.cn/skills/user_0fcf0d65/universal-prompt-pro)
