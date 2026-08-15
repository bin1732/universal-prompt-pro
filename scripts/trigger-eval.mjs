#!/usr/bin/env node
// trigger-eval.mjs — 触发评测执行器（P0 补全，采纳 anthropics/skills 官方方法论）
// 原理: description 是触发的唯一依据。本评测器模拟宿主"读 description 判定查询"：
//   1. 解析 SKILL.md frontmatter 的 description
//   2. 校验 description 是否覆盖对象词（提示词/prompt/system prompt/指令…）
//   3. 对 assets/evals/triggers.json 的 should/should-not 查询逐条判定
//   4. 输出触发率报告 + 失败诊断（未触发缺什么词 / 误触含什么词）
// 验收: should 触发 ≥90%，should-not 误触 ≤10%（与 triggers.json meta.acceptance 一致）
// 用法:
//   node scripts/trigger-eval.mjs                 # 用默认 SKILL.md + assets/evals/triggers.json
//   node scripts/trigger-eval.mjs --skill <path> --cases <path> --json
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SKILL = join(ROOT, "SKILL.md");
const DEFAULT_CASES = join(ROOT, "assets", "evals", "triggers.json");

// 触发对象词（description 必须覆盖；宿主据此判定"查询是否与提示词工程相关"）
const OBJECT_WORDS = ["提示词", "prompt", "system prompt", "system_prompt", "指令", "agent"];

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("SKILL.md 缺少 frontmatter");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

export function evaluateTriggers({ skillPath = DEFAULT_SKILL, casesPath = DEFAULT_CASES } = {}) {
  const skill = readFileSync(skillPath, "utf8");
  const fm = parseFrontmatter(skill);
  const description = fm.description || "";
  if (!description) throw new Error("SKILL.md 缺少 description");

  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const should = cases.should_trigger || [];
  const shouldNot = cases.should_not_trigger || [];

  // 1. description 覆盖校验：对象词必须出现在 description（否则宿主无从判定）
  const missingWords = OBJECT_WORDS.filter((w) => !description.toLowerCase().includes(w));
  const coverage = {
    ok: missingWords.length === 0,
    missing: missingWords,
    note: missingWords.length ? `description 缺少对象词: ${missingWords.join("/")}` : "对象词覆盖完整",
  };

  // 2. 判定：查询小写化后含任一对象词 → 触发
  const judge = (query) => {
    const q = query.toLowerCase();
    const hit = OBJECT_WORDS.find((w) => q.includes(w));
    return { triggered: !!hit, via: hit || null };
  };

  const shouldResults = should.map((c) => {
    const j = judge(c.query);
    return { id: c.id, query: c.query, note: c.note, ...j, pass: j.triggered === true };
  });
  const shouldNotResults = shouldNot.map((c) => {
    const j = judge(c.query);
    return { id: c.id, query: c.query, note: c.note, ...j, pass: j.triggered === false };
  });

  const shouldRate = shouldResults.filter((r) => r.pass).length / shouldResults.length;
  const notRate = shouldNotResults.filter((r) => r.pass).length / shouldNotResults.length;
  const falsePositive = 1 - notRate;

  // 3. 失败诊断
  const diagnostics = [];
  for (const r of shouldResults.filter((x) => !x.pass)) {
    diagnostics.push(`[未触发] ${r.id} "${r.query.slice(0, 30)}" — 查询不含任何对象词（${OBJECT_WORDS.join("/")}）`);
  }
  for (const r of shouldNotResults.filter((x) => !x.pass)) {
    diagnostics.push(`[误触] ${r.id} "${r.query.slice(0, 30)}" — 含对象词 "${r.via}" 被误判为提示词工程请求`);
  }

  const acceptance = cases.meta?.acceptance || { should_trigger_min: 0.9, should_not_false_positive_max: 0.1 };

  return {
    meta: { skill: fm.name || "unknown", description_preview: description.slice(0, 80) + "…" },
    coverage,
    results: { should: shouldResults, should_not: shouldNotResults },
    rates: {
      should_trigger_rate: Math.round(shouldRate * 1000) / 10,
      false_positive_rate: Math.round(falsePositive * 1000) / 10,
    },
    diagnostics,
    gate: {
      should_ok: shouldRate >= acceptance.should_trigger_min,
      false_positive_ok: falsePositive <= acceptance.should_not_false_positive_max,
      overall_ok: shouldRate >= acceptance.should_trigger_min && falsePositive <= acceptance.should_not_false_positive_max,
    },
  };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const wantJson = args.includes("--json");
  const r = evaluateTriggers({ skillPath: opt("skill") || DEFAULT_SKILL, casesPath: opt("cases") || DEFAULT_CASES });
  // 验收阈值从 cases meta 读取，避免硬编码漂移
  const acceptance = r.gate; // should_ok / false_positive_ok

  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log(`=== 触发评测 [${r.meta.skill}] ===`);
    console.log(`description: ${r.meta.description_preview}`);
    console.log(`对象词覆盖: ${r.coverage.ok ? "✓" : "✗ " + r.coverage.missing.join("/")}`);
    console.log("");
    console.log(`应触发: ${r.rates.should_trigger_rate}% (需 ≥90%)`);
    console.log(`误触率: ${r.rates.false_positive_rate}% (需 ≤10%)`);
    console.log("");
    for (const d of r.diagnostics) console.log(d);
    console.log("");
    console.log(`门禁: ${r.gate.overall_ok ? "✅ 通过" : "❌ 不通过"}`);
  }
}
