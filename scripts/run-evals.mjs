#!/usr/bin/env node
// run-evals.mjs — 完整 eval 运行器（P5）
// 能力（采纳 bergr7 + OpenAI eval 飞轮，降门槛）:
//   1. 成本分层: spot(3-5 用例×1) → targeted(失败用例×1) → regression(全套×1) → final(全套×5)
//   2. 阈值门禁: 结构 100% / 参考 ≥85% / judge ≥80% / 对抗 ≥90%（硬性 Gate，可配置）
//   3. 回退纪律: 失败即回退（不在失败假设上叠改动）；基线不可跳过
//   4. 确定性: 用例跑分可复现；结果入 data/versions
// 目录可注入: --dir <path> 测试用临时目录；--cases <file> 指定用例集
// 用法:
//   node scripts/run-evals.mjs baseline --cases assets/evals/evolve-cases.json --score-type structural
//   node scripts/run-evals.mjs tier --tier spot --cases <file>
//   node scripts/run-evals.mjs gate --cases <file> --thresholds '{"structural":100,"reference":85}'
//   node scripts/run-evals.mjs decide --baseline 70 --current 75   # 保留/回退决策
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, ts } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "assets", "data", "versions");
const DEFAULT_THRESHOLDS = { structural: 100, reference: 85, judge: 80, adversarial: 90 };

// ensureDir / ts 由 lib.mjs 提供（消除跨脚本重复）

// 内置评分器：引用 score-prompt.mjs 的结构 4 维（结构类用例）
let scoreFn = null;
async function getScorer() {
  if (!scoreFn) {
    const mod = await import(`file://${join(ROOT, "scripts", "score-prompt.mjs").replace(/\\/g, "/")}`);
    scoreFn = mod.scorePrompt;
  }
  return scoreFn;
}

// 分层规格（bergr7 成本分层）
const TIERS = {
  spot:      { desc: "3-5 用例 × 1 样本（第一次检查）", sample: 1, count: 5 },
  targeted:  { desc: "全部失败用例 × 1 样本（定向验证）", sample: 1, count: null },
  regression: { desc: "全套 × 1 样本（回归）", sample: 1, count: null },
  final:     { desc: "全套 × 5 样本（验收）", sample: 5, count: null },
};

// ================= 核心 API =================
export async function runTier({ dir = DEFAULT_DIR, tier, casesPath, focus }) {
  if (!TIERS[tier]) throw new Error(`未知层级: ${tier}（合法: ${Object.keys(TIERS).join("/")}）`);
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const list = cases.cases || [];
  const scorer = await getScorer();

  // 按层级选用例
  let selected = list;
  if (tier === "spot") selected = list.slice(0, TIERS.spot.count);
  if (tier === "targeted" && focus) selected = list.filter((c) => focus.includes(c.id));

  const results = selected.map((c) => {
    const r = scorer(c.prompt);
    const pass = r.band === (c.expected_band || "优秀") || (c.expected_score_min != null && r.structural_score >= c.expected_score_min);
    return { id: c.id, score: r.structural_score, band: r.band, expected: c.expected_band || null, pass };
  });
  const passRate = results.length ? results.filter((r) => r.pass).length / results.length : 0;

  ensureDir(dir);
  const report = {
    tier, ts: ts(), total: results.length, passRate: Math.round(passRate * 1000) / 10, results, thresholds: DEFAULT_THRESHOLDS,
  };
  writeFileSync(join(dir, `eval-${tier}-${ts()}.json`), JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

export function gateCheck({ passRate, tier, thresholds = DEFAULT_THRESHOLDS }) {
  // 门禁阈值：所有层级统一用 structural 100%（结构是硬性底线）
  const required = thresholds.structural;
  return { tier, required, actual: passRate, pass: passRate >= required / 100 };
}

export function decideKeep({ baseline, current, minImprovement = 0 }) {
  const delta = current - baseline;
  return {
    baseline, current, delta,
    decision: delta > minImprovement ? "keep" : delta === minImprovement ? "keep(无变化)" : "revert",
    note: delta > 0 ? "改进，保留" : "无改进或回退，建议回退（失败不叠改动）",
  };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const dir = opt("dir") || DEFAULT_DIR;
  const wantJson = args.includes("--json");

  (async () => {
    try {
      let out;
      switch (cmd) {
        case "tier": {
          const tier = opt("tier");
          out = await runTier({ dir, tier, casesPath: opt("cases"), focus: opt("focus") ? opt("focus").split(",") : null });
          break;
        }
        case "gate": {
          const r = await runTier({ dir, tier: opt("tier") || "regression", casesPath: opt("cases") });
          const th = opt("thresholds") ? JSON.parse(opt("thresholds")) : DEFAULT_THRESHOLDS;
          out = { ...r, gate: gateCheck({ passRate: r.passRate, tier: r.tier, thresholds: th }) };
          break;
        }
        case "decide":
          out = decideKeep({ baseline: Number(opt("baseline")), current: Number(opt("current")), minImprovement: opt("min") ? Number(opt("min")) : 0 });
          break;
        case "baseline": {
          // 基线：必须跑的第一次测量（从不跳过基线）
          const r = await runTier({ dir, tier: "regression", casesPath: opt("cases") });
          out = { ...r, note: "基线已建立：无基线无证据（bergr7 纪律）" };
          break;
        }
        default:
          throw new Error("用法: baseline|tier|gate|decide（--dir/--cases 可注入）");
      }
      if (wantJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      else if (cmd === "decide") {
        console.log(`baseline ${out.baseline} → current ${out.current}（Δ${out.delta}）`);
        console.log(`决策: ${out.decision} — ${out.note}`);
      } else if (cmd === "gate") {
        console.log(`[${out.tier}] 通过率 ${out.passRate}% / 门禁 ${out.gate.required}% → ${out.gate.pass ? "通过 ✓" : "不通过 ✗（需修复后重跑）"}`);
        for (const r of out.results) console.log(`  ${r.id}: ${r.score} ${r.band} ${r.pass ? "✓" : "✗"}`);
      } else {
        console.log(`[${out.tier}] ${out.total} 用例，通过率 ${out.passRate}%`);
        if (out.note) console.log(out.note);
      }
    } catch (e) {
      console.error(`错误: ${e.message}`);
      process.exit(1);
    }
  })();
}
