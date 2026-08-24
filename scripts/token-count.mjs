#!/usr/bin/env node
// token-count.mjs — Token 经济性引擎（P3）
// 能力:
//   1. token 估算（中文 1 字≈1.0 token，英文 1 词≈1.3 token，与 validate.mjs 口径一致）
//   2. 预算偏差计算（目标预算 vs 实际估算）
//   3. 冗余检测: 重复约束 / 同义堆叠 / 套话 / 过度修饰（确定性规则 + 证据引用）
// 设计原则: 确定性（同输入恒同输出）；证据引用（每条冗余附原文+行号+规则名）；不误伤（只报高置信模式）
// 用法:
//   node scripts/token-count.mjs <prompt.txt>                 # 人类可读报告
//   node scripts/token-count.mjs <prompt.txt> --json
//   node scripts/token-count.mjs <prompt.txt> --budget 300     # 指定目标预算
//   echo "..." | node scripts/token-count.mjs
import { readFileSync } from "node:fs";

// ================= 冗余模式库（高置信，避免误伤） =================

const REDUNDANCY_PATTERNS = {
  synonymStack: [
    { re: /请务必|务必|一定|千万(要|别)|切记/g, label: "同义堆叠（务必/一定/千万…）" },
    { re: /非常(非常|十分|特别|极其)/g, label: "同义堆叠（非常非常/十分…）" },
  ],
  emptyPhrases: [
    { re: /充分发挥(您)?(的)?(专业|全部)?(能力|水平)/g, label: "无信息量套话（请充分发挥您的专业能力…）" },
    { re: /(让我们|大家一起|携手|共同)努力/g, label: "无信息量套话（让我们一起努力…）" },
    { re: /(众所周知|不言而喻|显而易见)/g, label: "无信息量套话（众所周知…）" },
    { re: /(希望能|期待您|麻烦您)不吝/g, label: "无信息量套话（希望您不吝…）" },
  ],
  overModification: [
    { re: /(极其|非常|超级|十分|格外|特别)(重要|关键|必要|优秀|好|强大)/g, label: "过度修饰（极其重要/超级好…）" },
  ],
};

// 重复约束检测：同一约束短语（长度≥4 的关键句）出现 ≥2 次
function findRepeated(text) {
  const sentences = text.split(/[。；;！!？?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 6);
  const counts = new Map();
  for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
  const hits = [];
  for (const [s, n] of counts) {
    if (n >= 2) {
      const lineNo = text.indexOf(s) >= 0 ? text.slice(0, text.indexOf(s)).split("\n").length : 1;
      hits.push({ rule: "重复约束（同一句出现 " + n + " 次）", quote: s.slice(0, 40), line: lineNo });
    }
  }
  return hits;
}

// ================= token 估算 =================
export function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const nonCjkWords = text.split(/\s+/).filter(Boolean).filter((t) => !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t)).length;
  const tokens = Math.round(cjk * 1.0 + nonCjkWords * 1.3);
  return { cjk, nonCjkWords, tokens };
}

// ================= token 报告（估算口径，确定性） =================
// 说明：估算口径对中文偏乐观（真实 tokenizer 1 字常为 1.5-2 token）；精确值以目标模型 API 计费口径为准。
export async function tokenReport(text) {
  const est = estimateTokens(text);
  return {
    estimate: est,
    precise: null,
    engine: "estimate",
    note: "估算口径（中文 1 字≈1.0 token，英文 1 词≈1.3 token）",
  };
}

// ================= 冗余检测 =================
export function detectRedundancy(text) {
  const findings = [];
  const notes = [];

  // 1. 同义堆叠 / 套话 / 过度修饰（正则命中即报）
  for (const [cat, patterns] of Object.entries(REDUNDANCY_PATTERNS)) {
    for (const p of patterns) {
      const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
      let m;
      while ((m = re.exec(text)) !== null) {
        const lineNo = text.slice(0, m.index).split("\n").length;
        findings.push({ type: cat, rule: p.label, quote: m[0], line: lineNo, savings: m[0].length });
        if (re.lastIndex === m.index) re.lastIndex++;
        if (findings.length >= 15) break;
      }
      if (findings.length >= 15) break;
    }
    if (findings.length >= 15) break;
  }

  // 2. 重复约束
  const repeated = findRepeated(text);
  findings.push(...repeated.map((h) => ({ type: "duplicate", rule: h.rule, quote: h.quote, line: h.line, savings: h.quote.length })));

  return { findings: findings.slice(0, 20), notes };
}

// ================= 预算计算 =================
export function budgetReport(text, targetBudget) {
  const est = estimateTokens(text);
  const deviation = targetBudget != null && targetBudget > 0 ? ((est.tokens - targetBudget) / targetBudget) * 100 : null;
  return {
    estimate: est,
    target_budget: targetBudget ?? null,
    deviation_pct: deviation == null ? null : Math.round(deviation * 10) / 10,
    over_budget: deviation != null && deviation > 0,
    band: targetBudget == null
      ? null
      : deviation <= -20 ? "精简档（低于预算 20%+）"
        : deviation <= 0 ? "标准档"
          : deviation <= 30 ? "超预算（需压缩）"
            : "严重超预算（必须压缩）",
  };
}

// ================= 可执行压缩步骤（compress 意图落地，按 token-economy.md §4 优先级） =================
const COMPRESS_PRIORITY = {
  duplicate: 1,
  emptyPhrases: 2,
  synonymStack: 3,
  overModification: 4,
};
const COMPRESS_ACTION = {
  duplicate: "整句删除（重复约束，最高置信）",
  emptyPhrases: "整句删除（无信息量套话）",
  synonymStack: "保留一个强化词，删除其余堆叠",
  overModification: "删除过度修饰词（无测量对象）",
};

export function compressSteps(text) {
  const { findings } = detectRedundancy(text);
  const steps = findings
    .map((f) => ({
      priority: COMPRESS_PRIORITY[f.type] ?? 5,
      action: COMPRESS_ACTION[f.type] || "精简措辞（人工判断，引擎只提示）",
      rule: f.rule,
      quote: f.quote,
      line: f.line,
      savings: f.savings,
    }))
    .sort((a, b) => a.priority - b.priority);
  const totalSavings = steps.reduce((s, x) => s + (x.savings || 0), 0);
  return {
    steps: steps.slice(0, 10),
    total_savings_chars: totalSavings,
    note: "压缩优先级（token-economy.md §4）：1 重复约束 → 2 套话 → 3 同义堆叠 → 4 过度修饰 → 5 措辞精简（人工）；压缩 ≥30% 时建议 eval 回归验证不降性能",
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
  const budgetIdx = args.indexOf("--budget");
  const targetBudget = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : null;
  const fileArg = args.find((a) => !a.startsWith("--") && !/^-?\d+$/.test(a) && !a.startsWith("{") && !a.startsWith("["));
  let input;
  if (fileArg) input = readFileSync(fileArg, "utf8");
  else input = readFileSync(0, "utf8");

  const result = {
    budget: budgetReport(input, targetBudget),
    redundancy: detectRedundancy(input),
    compress: compressSteps(input),
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const b = result.budget;
    console.log("=== Token 经济性报告 ===");
    console.log(`估算: ${b.estimate.tokens} token（中文 ${b.estimate.cjk} 字，英文 ${b.estimate.nonCjkWords} 词）`);
    if (b.target_budget != null) {
      console.log(`目标预算: ${b.target_budget} token；偏差: ${b.deviation_pct}%；档位: ${b.band}`);
    } else {
      console.log("目标预算: 未指定（用 --budget <n> 设置）");
    }
    console.log("");
    console.log(`冗余检测: 命中 ${result.redundancy.findings.length} 处`);
    for (const f of result.redundancy.findings) {
      console.log(`  - [${f.type}] 第${f.line}行 "${f.quote}" ← ${f.rule}（可省 ~${f.savings} 字符）`);
    }
    if (!result.redundancy.findings.length) console.log("  （未发现高置信冗余）");
  }
}
