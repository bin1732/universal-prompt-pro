# references/installation-guide.md — 安装指南

> 本 skill 遵循 Agent Skills 规范组织（目录含 SKILL.md + references/ + scripts/），可装入任何支持 Agent Skills 规范的宿主（Claude Code / Codex / Cursor 等）。

## 安装要点

skill 的 `name` 为 `universal-prompt-pro`（frontmatter name 字段）。安装时请将解压内容放入**以该名称命名的目录**，宿主才能正确发现与加载。

### Claude Code（用户级）

```bash
mkdir -p ~/.claude/skills/universal-prompt-pro
# 将 SKILL.md、references/、scripts/ 解压到该目录
```

### Codex / OpenAI（用户级）

```bash
mkdir -p ~/.agents/skills/universal-prompt-pro
# 将 SKILL.md、references/、scripts/ 解压到该目录
```

### 项目级（仅当前项目生效）

```bash
mkdir -p .claude/skills/universal-prompt-pro
# 将 SKILL.md、references/、scripts/ 解压到该目录
```

## 升级与数据

- 升级前备份运行时数据目录 `data/`（版本快照、习惯画像、检索缓存、经验库——由各引擎自动创建，随 skill 运行产生）。
- 升级时覆盖 `SKILL.md` / `references/` / `scripts/` 即可，**不要删除 `data/`**。

## 环境要求

- 执行引擎需 Node ≥14.18（ESM 顶层 await）。
- 联网核验工具 `fetch-prompt-practices.mjs` 需 Node ≥18（内置 fetch）。
- 零外部依赖（无第三方包）；离线时联网核验工具明确失败或返回缓存快照，不编造。
