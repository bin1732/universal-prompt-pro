#!/usr/bin/env node
// qscore-full.mjs — Q-Score 8 维合成引擎（P5+ 补全）
// 能力: 结构 4 维（复用 score-prompt.mjs）+ 语义 4 维（复用 sem-score.mjs）→ 完整 Q-Score
// 权重: Clarity15/Specificity15/Structure10/Robustness10/Fit15/Economy10/Verifiability15/Safety10 = 100%
// 设计原则:
//   1. 确定性: 8 维全部规则驱动, 同输入恒同输出
//   2. 诚实边界: Fit 缺环境指纹时该维不参与计分并标注"缺环境，置信度低"（不假装精确）
//   3. 证据表: 输出逐维分数 + 证据 + 短板定位（"真实判断好坏"的完整交付）
// 用法:
//   node scripts/qscore-full.mjs <prompt.txt> --fp '{"model_family":"claude","task_type":"代码","template":"RISEN"}' --budget 300
//   node scripts/qscore-full.mjs <prompt.txt> --fp '...' --json
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WEIGHTS = {
  clarity: 0.15, specificity: 0.15, structure: 0.10, robustness: 0.10,
  fit: 0.15, economy: 0.10, verifiability: 0.15, safety: 0.10,
};

let structMod = null, semMod = null;
async function getModules() {
  if (!structMod) structMod = await import(`file://${join(ROOT, "scripts", "score-prompt.mjs").replace(/\\/g, "/")}`);
  if (!semMod) semMod = await import(`file://${join(ROOT, "scripts", "sem-score.mjs").replace(/\\/g, "/")}`);
  return { struct: structMod, sem: semMod };
}

export async function scoreFull(prompt, opts = {}) {
  if (!prompt || !prompt.trim()) throw new Error("输入为空");
  const { fp = {}, target_budget, semanticOverride = null } = opts;
  const { struct, sem } = await getModules();

  // 结构 4 维（同步）
  const sr = struct.scorePrompt(prompt);
  const dims = {
    clarity: sr.dimensions.clarity,
    specificity: sr.dimensions.specificity,
    structure: sr.dimensions.structure,
    robustness: sr.dimensions.robustness,
  };

  // 语义 4 维（异步，规则版基线）
  const semr = await sem.scoreSemantic(prompt, { fp, target_budget });
  dims.fit = semr.fit;
  dims.economy = semr.economy;
  dims.verifiability = semr.verifiability;
  dims.safety = semr.safety;

  // —— LLM 判定版覆盖（契约 references/llm-judge-prompt.md §5，消除"表面功能"）——
  // 提供 semanticOverride（宿主 LLM 判定结果）时：经 judge-validate 校验 → 通过则按置信度
  // 加权覆盖语义 4 维分数；校验失败或未提供 → 回退规则版分数（诚实边界 P8）。
  let semantic_override_applied = false;
  if (semanticOverride) {
    try {
      const jv = await import(`file://${join(ROOT, "scripts", "judge-validate.mjs").replace(/\\/g, "/")}`);
      const validated = jv.validate(semanticOverride);
      if (!validated.ok) {
        for (const d of ["fit", "economy", "verifiability", "safety"]) {
          dims[d].notes = [...(dims[d].notes || []), "LLM 判定未通过校验，已回退规则版（P8）"];
        }
      } else {
        // 按置信度加权覆盖（confidence=low → 权重 0.5，medium → 0.75，high → 1.0）
        const weightMap = { high: 1.0, medium: 0.75, low: 0.5 };
        for (const d of ["fit", "economy", "verifiability", "safety"]) {
          const jd = validated.normalized[d];
          if (jd && typeof jd.score === "number") {
            const w = weightMap[jd.confidence] ?? 1.0;
            dims[d].score = Math.round(jd.score * w);
            dims[d].notes = [...(dims[d].notes || []),
              `LLM 判定版覆盖（原分 ${jd.score} × 置信度权重 ${w} = ${Math.round(jd.score * w)}）`];
          }
        }
        semantic_override_applied = true;
      }
    } catch (e) {
      for (const d of ["fit", "economy", "verifiability", "safety"]) {
        dims[d].notes = [...(dims[d].notes || []), `LLM 判定处理失败，已回退规则版（P8）: ${e.message.slice(0, 40)}`];
      }
    }
  }

  // 堆砌检测（A-14 根因修复）：加分关键词密集但缺真实约束 → Verifiability 降权
  // 特征: Verifiability 近满分(≥90) + Specificity 不高(≤80) + 文本短(<150字) = 疑似词库堆砌
  // 必须在 total 计算之前执行，否则降权不生效
  const vScore = dims.verifiability.score;
  const sScore = dims.specificity.score;
  const shortText = prompt.length < 150;
  if (vScore != null && sScore != null && vScore >= 90 && sScore <= 80 && shortText) {
    dims.verifiability.score = 45;
    dims.verifiability.notes = [...(dims.verifiability.notes || []),
      "疑似关键词堆砌：加分关键词密集但 Specificity 不高（无真实约束），Verifiability 已降权至 45（诚实边界 P8）"];
  }

  // 合成：fit 缺环境时不参与（权重按剩余维度归一化）
  let total = 0;
  let weightSum = 0;
  const unavailable = [];
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const d = dims[k];
    if (d.score == null) { unavailable.push(k); continue; }
    total += d.score * w;
    weightSum += w;
  }
  const normalizedTotal = Math.round(total / weightSum);
  const band = normalizedTotal < 55 ? "需重写" : normalizedTotal < 70 ? "定向修补" : normalizedTotal < 85 ? "可用" : "优秀";

  // 短板定位：低于 60 的维度
  const weak = Object.entries(dims)
    .filter(([, d]) => typeof d.score === "number" && d.score < 60)
    .map(([k, d]) => ({ dim: k, score: d.score, reason: d.findings?.[0]?.rule || d.notes?.[0] || "分数偏低" }));

  return {
    meta: {
      engine: "qscore-full.mjs v1.0.1",
      weights: WEIGHTS,
      unavailable_dims: unavailable,
      semantic_override_applied,
      note: unavailable.length ? `缺环境信息，${unavailable.join("/")} 未参与计分，总分按剩余权重归一化` : "8 维完整计分",
    },
    total_score: normalizedTotal,
    band,
    dimensions: dims,
    weak_spots: weak.slice(0, 5),
  };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法: node " + process.argv[1].split(/[\\/]/).pop() + " [选项]（完整用法见脚本头部注释）");
    process.exit(0);
  }
  const wantJson = args.includes("--json");
  const fpIdx = args.indexOf("--fp");
  let fp = {};
  if (fpIdx >= 0) {
    try {
      fp = JSON.parse(args[fpIdx + 1]);
    } catch {
      console.error("错误: --fp 不是合法 JSON（已按空指纹处理，Fit 维降级）");
      process.exit(1);
    }
  }
  const budgetIdx = args.indexOf("--budget");
  const targetBudget = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : null;
  const fileArg = args.find((a) => !a.startsWith("--") && !a.startsWith("{") && !a.startsWith("[") && !/^-?\d+$/.test(a));
  let input;
  if (fileArg) input = readFileSync(fileArg, "utf8");
  else input = readFileSync(0, "utf8");

  const r = await scoreFull(input, { fp, target_budget: targetBudget });
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log("=== Q-Score 完整评分（8 维） ===");
    console.log(`总分: ${r.total_score}/100 [${r.band}]`);
    if (r.meta.unavailable_dims.length) console.log(`⚠️ ${r.meta.note}`);
    console.log("");
    const names = {
      clarity: "Clarity 清晰", specificity: "Specificity 具体", structure: "Structure 结构", robustness: "Robustness 鲁棒",
      fit: "Fit 环境适配", economy: "Economy 用词经济", verifiability: "Verifiability 可证伪", safety: "Safety 安全",
    };
    for (const [k, w] of Object.entries(WEIGHTS)) {
      const d = r.dimensions[k];
      const wLabel = `(${Math.round(w * 100)}%)`;
      if (d.score == null) {
        console.log(`[${names[k]} ${wLabel}] 无法判定（缺环境）`);
        continue;
      }
      console.log(`[${names[k]} ${wLabel}] ${d.score}/100`);
      for (const f of d.findings || []) {
        if (f.type === "missing" || (f.line == null && f.quote == null)) console.log(`   - [缺失] ${f.rule}`);
        else console.log(`   - [证据] 第${f.line}行 "${f.quote}" ← ${f.rule}`);
      }
      for (const n of d.notes || []) console.log(`   - [说明] ${n}`);
    }
    if (r.weak_spots.length) {
      console.log("");
      console.log("短板定位（<60 分维度）:");
      for (const w of r.weak_spots) console.log(`  - ${names[w.dim]}: ${w.score} ← ${w.reason}`);
    }
  }
}
