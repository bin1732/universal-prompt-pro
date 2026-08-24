# references/engine-catalog.md — 可执行引擎清单

> 本文件列出本 skill 附带的全部可执行引擎（scripts/），供宿主按需读取（渐进披露：SKILL.md 只保留入口，完整清单在此，需要时读取）。
> 覆盖阶段：L0 安全 → L3 构建 → L4 评分 → L5 版本化 → P5 进化/画像/评测 → 门禁/一致性/安全自检 → 联网核验。

| 阶段 | 引擎 | 用途 | 用法示例 |
|------|------|------|----------|
| 端到端 | `pipe.mjs` | 完整闭环（安全→构建→评分→版本化）；`--judge <json>` 注入 LLM 判定 | `node scripts/pipe.mjs --request "..." --fp '{}'` |
| L0 安全 | `scan-safety.mjs` | 注入/红线/PII/灰线扫描 | `echo "..." \| node scripts/scan-safety.mjs` |
| L3 构建 | `build-prompt.mjs` | 环境指纹→模板路由→组装 | `node scripts/build-prompt.mjs <fp.json>` |
| L4 评分 | `score-prompt.mjs` | 结构 4 维评分 | `node scripts/score-prompt.mjs <p.txt>` |
| L4 评分 | `sem-score.mjs` | 语义 4 维评分（规则版） | `node scripts/sem-score.mjs <p.txt> --fp '{}'` |
| L4 评分 | `qscore-full.mjs` | 8 维合成 + LLM 判定覆盖 | `node scripts/qscore-full.mjs <p.txt> --fp '{}'` |
| L4 评分 | `judge-validate.mjs` | LLM 判定校验（失败回退） | `node scripts/judge-validate.mjs <judge.json>` |
| L3 经济 | `token-count.mjs` | token 估算/预算/冗余/压缩步骤 | `node scripts/token-count.mjs <p.txt> --budget 300` |
| L3 情报 | `search-cache.mjs` | 检索建议缓存（TTL 7 天） | `node scripts/search-cache.mjs put --key K --data '{}'` |
| L3 情报 | `fetch-prompt-practices.mjs` | 官方提示词实践联网核验（缓存+降级） | `node scripts/fetch-prompt-practices.mjs --json` |
| L5 版本 | `version-store.mjs` | 快照/对比/回滚 | `node scripts/version-store.mjs snapshot --prompt "..."` |
| P5 画像 | `habit-profile.mjs` | 画像读写/清空 | `node scripts/habit-profile.mjs show` |
| P5 进化 | `evolve.mjs` | 失败入库/提案/确认 | `node scripts/evolve.mjs stats` |
| P5 eval | `run-evals.mjs` | 分层 eval/门禁/决策 | `node scripts/run-evals.mjs gate --cases references/evals/scoring.json` |
| P5 评审 | `expert-panel.mjs` | 双档切换/编排/仲裁 | `node scripts/expert-panel.mjs mode --score 78` |
| P0 触发 | `trigger-eval.mjs` | 触发评测 | `node scripts/trigger-eval.mjs` |
| P5 校准 | `calibrate.mjs` | 专家盲评一致性 | `node scripts/calibrate.mjs` |
| 门禁 | `validate.mjs` | P0-P5 全门禁回归 | `node scripts/validate.mjs` |
| 一致性 | `matrix-check.mjs` | 四方矩阵一致性 | `node scripts/matrix-check.mjs` |
| 攻击 | `attack.mjs` | 安全自检（34 用例，含全角/词库降级回归） | `node scripts/attack.mjs` |
| 公共库 | `lib.mjs` | 共享工具（ROOT/clamp/ts/ensureDir） | 被各引擎 import |

## 使用建议

- 需要执行安全扫描时读 `scan-safety.mjs`；需要评分时读 `score-prompt.mjs`/`sem-score.mjs`/`qscore-full.mjs`；需要版本化时读 `version-store.mjs`。
- 全量质量自检一次：`node scripts/validate.mjs`（完整性门禁）+ `node scripts/attack.mjs`（安全自检）+ `node scripts/matrix-check.mjs`（一致性）。
- 联网核验官方提示词实践：`node scripts/fetch-prompt-practices.mjs --json`（缓存+降级，无网络时明确失败或返回快照）。
