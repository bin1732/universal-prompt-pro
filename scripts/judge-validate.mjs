#!/usr/bin/env node
// judge-validate.mjs — LLM 判定结果校验器
// 用途：校验宿主 LLM 按 references/llm-judge-prompt.md §2 返回的语义 4 维判定 JSON，
//       防虚假判定（格式错误/缺维/裸分/证据不齐/分数越界/置信度非法）。
// 校验通过 → 可合成到 Q-Score（qscore-full.mjs 的 semanticOverride）；
// 校验失败 → 必须回退规则版（sem-score.mjs），不崩溃（诚实边界 P8）。
// 用法:
//   node scripts/judge-validate.mjs <judge.json>          # 校验文件
//   echo '<json>' | node scripts/judge-validate.mjs       # 或 stdin
//   node scripts/judge-validate.mjs --merge <judge.json>  # 校验并给出可合成结果
import { readFileSync } from "node:fs";

const DIMS = ["fit", "economy", "verifiability", "safety"];
const CONFIDENCE = ["high", "medium", "low"];
// confidence=low 时权重减半（契约 §2）
const CONFIDENCE_WEIGHT = { high: 1.0, medium: 0.75, low: 0.5 };

export function validate(judgeObj) {
  const errors = [];
  const warnings = [];
  const normalized = {};

  if (!judgeObj || typeof judgeObj !== "object" || Array.isArray(judgeObj)) {
    return { ok: false, errors: ["判定结果必须是 JSON 对象"], warnings, normalized: null };
  }

  // 1. 维度覆盖：四维必须齐全
  const present = DIMS.filter((d) => d in judgeObj);
  for (const d of DIMS) {
    if (!(d in judgeObj)) errors.push(`缺少维度: ${d}`);
  }

  // 2. 每维校验
  for (const d of DIMS) {
    const dim = judgeObj[d];
    if (dim == null) continue;
    if (typeof dim !== "object" || Array.isArray(dim)) {
      errors.push(`${d}: 必须是对象`);
      continue;
    }
    const out = { score: null, evidence: [], confidence: "high", notes: [] };

    // 分数范围
    const s = dim.score;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 100) {
      errors.push(`${d}.score 必须是 0-100 整数（收到: ${JSON.stringify(s)}）`);
    } else {
      out.score = s;
    }

    // 置信度合法
    const conf = dim.confidence ?? "high";
    if (!CONFIDENCE.includes(conf)) {
      errors.push(`${d}.confidence 非法（收到: ${conf}，合法: ${CONFIDENCE.join("/")}）`);
    } else {
      out.confidence = conf;
    }

    // 证据：非零分必须 ≥1 条完整证据（quote+line+reason）；零分允许空证据但须说明
    // 例外（契约 §2 示例）：safety 满分 100 + notes 说明 = "未发现风险"判定，允许空证据
    const ev = Array.isArray(dim.evidence) ? dim.evidence : [];
    const badEv = ev.filter((e) => !e || typeof e !== "object" || typeof e.quote !== "string" || typeof e.line !== "number" || typeof e.reason !== "string");
    if (badEv.length) errors.push(`${d}: ${badEv.length} 条证据格式非法（需 quote:string + line:number + reason:string）`);
    else {
      out.evidence = ev.map((e) => ({ quote: e.quote.slice(0, 60), line: e.line, reason: e.reason }));
      const hasNotes = Array.isArray(dim.notes) && dim.notes.length > 0;
      if (typeof s === "number" && s > 0 && ev.length === 0) {
        if (d === "safety" && s === 100 && hasNotes) {
          warnings.push(`safety: 满分 100 且无证据（"未发现风险"判定，依赖 notes 说明，契约 §2 允许）`);
        } else {
          errors.push(`${d}: 非零分 ${s} 但无证据（禁止裸分，契约 §1）`);
        }
      }
      if (s === 0 && ev.length === 0 && !hasNotes) {
        warnings.push(`${d}: 零分且无证据无说明（建议补充 notes 说明依据）`);
      }
    }

    // notes 数组
    out.notes = Array.isArray(dim.notes) ? dim.notes.map(String) : [];
    normalized[d] = out;
  }

  return { ok: errors.length === 0, errors, warnings, normalized: errors.length === 0 ? normalized : null };
}

// 可合成结果：应用置信度权重后的有效分数（校验通过才可调用）
export function mergeScores(judgeObj) {
  const v = validate(judgeObj);
  if (!v.ok) throw new Error("判定未通过校验，禁止合成（必须回退规则版）: " + v.errors.join("；"));
  const merged = {};
  for (const d of DIMS) {
    const dim = v.normalized[d];
    merged[d] = { score: dim.score, confidence: dim.confidence, effective_weight: CONFIDENCE_WEIGHT[dim.confidence] };
  }
  return merged;
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法: node " + process.argv[1].split(/[\\/]/).pop() + " [选项]（完整用法见脚本头部注释）");
    process.exit(0);
  }
  const wantMerge = args.includes("--merge");
  const wantJson = args.includes("--json");
  const fileArg = args.find((a) => !a.startsWith("--"));
  let input;
  if (fileArg) input = readFileSync(fileArg, "utf8");
  else input = readFileSync(0, "utf8");

  let judgeObj;
  try {
    judgeObj = JSON.parse(input);
  } catch (e) {
    console.error(`错误: 判定结果不是合法 JSON: ${e.message}`);
    process.exit(1);
  }

  if (wantMerge) {
    try {
      const merged = mergeScores(judgeObj);
      if (wantJson) process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
      else {
        console.log("=== 可合成结果（置信度加权） ===");
        for (const [d, m] of Object.entries(merged)) {
          console.log(`  ${d}: score=${m.score} confidence=${m.confidence} 有效权重=${m.effective_weight}`);
        }
      }
      process.exit(0);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  }

  const r = validate(judgeObj);
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log(`=== LLM 判定校验: ${r.ok ? "✅ 通过（可合成到 Q-Score）" : "❌ 不通过（必须回退规则版）"} ===`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (r.ok && r.normalized) {
      for (const d of DIMS) {
        const dim = r.normalized[d];
        console.log(`  ✓ ${d}: score=${dim.score} confidence=${dim.confidence} evidence=${dim.evidence.length}条 notes=${dim.notes.length}条`);
      }
    }
  }
  process.exit(r.ok ? 0 : 1);
}
