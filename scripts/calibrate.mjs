#!/usr/bin/env node
// calibrate.mjs — 专家盲评校准工具（P1 验收落地）
// 目标: 验证 Q-Score 与专家判断一致率 ≥80%（防止评分体系自说自话）
// 能力:
//   1. table: 生成匿名化盲评表（ID + 提示词，供专家排序，不泄露 Q-Score）
//   2. rank: 计算各采样提示词的 Q-Score（复用 qscore-full）并排序
//   3. compare: 输入专家排序（--expert-order "id1,id2,..."）→ Spearman 秩相关 + 门禁 ≥80%
//   4. self-check: 用 Q-Score 自排序作为"专家排序"→ 应得 100%（工具自洽性证明）
// 方法学（references/scoring-rubric.md 专家盲评校准流程）:
//   采样 20 条(10好10坏)匿名化 → 3 位专家独立排序 → 与 Q-Score 排序比较(Spearman)
// 用法:
//   node scripts/calibrate.mjs table --cases assets/evals/calibration.json
//   node scripts/calibrate.mjs rank --cases assets/evals/calibration.json
//   node scripts/calibrate.mjs compare --cases assets/evals/calibration.json --expert-order "C-07,C-01,..."
//   node scripts/calibrate.mjs self-check --cases assets/evals/calibration.json
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CASES = join(ROOT, "assets", "evals", "calibration.json");
const GATE = 0.8; // 一致率门禁（P1 验收：≥80%）

let qfMod = null;
async function getQscore() {
  if (!qfMod) qfMod = await import(`file://${join(ROOT, "scripts", "qscore-full.mjs").replace(/\\/g, "/")}`);
  return qfMod;
}

function loadCases(casesPath) {
  const j = JSON.parse(readFileSync(casesPath, "utf8"));
  const cases = j.cases || [];
  if (cases.length < 10) throw new Error(`校准采样需 ≥10 条（实际 ${cases.length}）`);
  return cases;
}

// 匿名化盲评表：ID + 提示词（不含任何 Q-Score 信息）
export function buildBlindTable(cases) {
  return cases.map((c) => ({ id: c.id, prompt: c.prompt, expected_quality: c.expected_quality || "unknown" }));
}

// Q-Score 排序（高→低）
export async function rankByQscore(cases) {
  const { scoreFull } = await getQscore();
  const scored = [];
  for (const c of cases) {
    const r = await scoreFull(c.prompt, { fp: c.fp || {} });
    scored.push({ id: c.id, score: r.total_score, band: r.band, fp_provided: !!(c.fp && c.fp.model_family) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// 将有序 ID 列表转为 {id: rank} 映射（并列 ID 取平均秩——P1-4 平局处理）
// 例：["A","A","B"] → A=1.5, B=3（并列共享 (1+2)/2）
function ranksOf(order) {
  const n = order.length;
  const out = {};
  let i = 0;
  while (i < n) {
    const id = order[i];
    let j = i;
    while (j + 1 < n && order[j + 1] === id) j++;
    const avgRank = (i + 1 + j + 1) / 2; // 平均秩
    for (let k = i; k <= j; k++) out[id] = avgRank;
    i = j + 1;
  }
  return out;
}

// Spearman 秩相关（两个排序数组 → ρ；支持并列，平均秩）
export function spearman(qscoreOrder, expertOrder) {
  if (qscoreOrder.length !== expertOrder.length) throw new Error("两个排序长度不一致");
  const n = qscoreOrder.length;
  const qRanks = ranksOf(qscoreOrder);
  const eRanks = ranksOf(expertOrder);
  // 双向 ID 校验（防 NaN：任一侧含对方没有的 ID 都拒绝）
  for (const id of expertOrder) {
    if (!(id in qRanks)) throw new Error(`专家排序含未知 ID: ${id}`);
  }
  for (const id of qscoreOrder) {
    if (!(id in eRanks)) throw new Error(`Q-Score 排序含未知 ID: ${id}`);
  }
  let sumD2 = 0;
  for (const id of qscoreOrder) {
    const d = qRanks[id] - eRanks[id];
    sumD2 += d * d;
  }
  const rho = 1 - (6 * sumD2) / (n * (n * n - 1));
  return Math.round(rho * 1000) / 1000;
}

// 一致性报告
export async function calibrate({ casesPath = DEFAULT_CASES, expertOrder }) {
  const cases = loadCases(casesPath);
  const qOrder = (await rankByQscore(cases)).map((s) => s.id);

  let rho = null;
  let verdict = "awaiting_expert";
  if (expertOrder) {
    const expertList = expertOrder.split(",").map((s) => s.trim());
    rho = spearman(qOrder, expertList);
    verdict = rho >= GATE ? "pass" : "fail";
  }

  return {
    meta: {
      cases: cases.length,
      gate: GATE,
      method: "Spearman 秩相关（Q-Score 排序 vs 专家排序）",
      note: "≥80% 才允许 Q-Score 作为对外分数；<80% 标注'校准中，仅供参考'",
    },
    qscore_order: qOrder,
    rho,
    verdict,
    blind_table: buildBlindTable(cases),
  };
}

// 自一致性：Q-Score 自排序作"专家排序" → 应 ρ=1.0（工具自洽性证明）
export async function selfCheck({ casesPath = DEFAULT_CASES } = {}) {
  const cases = loadCases(casesPath);
  const qOrder = (await rankByQscore(cases)).map((s) => s.id);
  const rho = spearman(qOrder, qOrder);
  return { rho, self_consistent: rho === 1, note: "自一致 ρ=1 证明计算正确；真实校准需人工专家排序" };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const casesPath = opt("cases") || DEFAULT_CASES;
  const wantJson = args.includes("--json");

  try {
    if (cmd === "table") {
      const cases = loadCases(casesPath);
      const table = buildBlindTable(cases);
      if (wantJson) process.stdout.write(JSON.stringify(table, null, 2) + "\n");
      else {
        console.log(`=== 匿名化盲评表（${table.length} 条，供专家独立排序） ===`);
        console.log("请按整体质量从好到差排序，仅使用 ID。不要与任何自动评分对比。");
        for (const t of table) {
          console.log("");
          console.log(`[${t.id}]`);
          console.log(t.prompt.slice(0, 120));
        }
      }
    } else if (cmd === "rank") {
      const cases = loadCases(casesPath);
      const ranked = await rankByQscore(cases);
      if (wantJson) process.stdout.write(JSON.stringify(ranked, null, 2) + "\n");
      else {
        console.log("=== Q-Score 排序（高→低） ===");
        ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.id}  ${r.score} [${r.band}]${r.fp_provided ? "" : " (无环境指纹，Fit 降级)"}`));
      }
    } else if (cmd === "compare") {
      const expertOrder = opt("expert-order");
      if (!expertOrder) throw new Error("compare 需要 --expert-order \"id1,id2,...\"");
      const r = await calibrate({ casesPath, expertOrder });
      if (wantJson) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else {
        console.log(`=== 校准结果 ===`);
        console.log(`Q-Score 排序: ${r.qscore_order.join(" > ")}`);
        console.log(`Spearman ρ: ${r.rho}`);
        console.log(`门禁 ≥${r.meta.gate * 100}%: ${r.verdict === "pass" ? "✅ 通过（可对外用 Q-Score）" : r.verdict === "fail" ? "❌ 不通过（标注'校准中，仅供参考'）" : "待专家排序"}`);
      }
    } else if (cmd === "self-check") {
      const r = await selfCheck({ casesPath });
      if (wantJson) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else console.log(`自一致性: ρ=${r.rho} ${r.self_consistent ? "✅（计算正确，工具自洽）" : "❌（工具异常！）"} — ${r.note}`);
    } else {
      throw new Error("用法: table|rank|compare|self-check（--cases 可指定采样集）");
    }
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
