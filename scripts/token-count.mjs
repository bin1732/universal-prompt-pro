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

// ================= 精确 token 计数（可选接入 tiktoken，P2-3） =================
// 目的：估算口径对中文偏乐观（真实 tokenizer 1 字常为 1.5-2 token）；安装 tiktoken 后可精确计数。
// 设计：动态 import，未安装或加载失败 → 返回 null（调用方降级为估算，诚实边界 P8，不崩溃）。
let tiktokenMod = null;
let tiktokenTried = false;

export async function preciseTokenCount(text) {
  if (!tiktokenTried) {
    tiktokenTried = true;
    try {
      tiktokenMod = await import("tiktoken");
    } catch {
      tiktokenMod = null; // 未安装/加载失败 → 降级
    }
  }
  if (!tiktokenMod || !tiktokenMod.encoding_for_model) return null;
  try {
    const enc = tiktokenMod.encoding_for_model("gpt-4o");
    const count = enc.encode(String(text || "")).length;
    enc.free();
    return { tokens: count, engine: "tiktoken(gpt-4o)", note: "精确计数（tiktoken）" };
  } catch {
    return null; // 编码器初始化失败 → 降级估算
  }
}

// 估算 + 精确（有 tiktoken 时优先精确，报告两种口径）
export async function tokenReport(text) {
  const est = estimateTokens(text);
  const precise = await preciseTokenCount(text);
  return {
    estimate: est,
    precise: precise ? precise.tokens : null,
    engine: precise ? "tiktoken" : "estimate",
    note: precise ? "精确计数（tiktoken 已安装）" : "估算口径（tiktoken 未安装，中文 1 字≈1.0 token）",
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

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
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
