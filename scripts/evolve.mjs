#!/usr/bin/env node
// evolve.mjs — 自进化引擎（P5，对应 data/failures + data/experience）
// 能力:
//   1. 失败案例入库: 记录 失败提示词 → 诊断 → 修复（无诊断不入库，防垃圾数据）
//   2. 经验提案: 每 N 条新失败聚类 → 生成"规则提案"（含证据）→ 标记 needs_confirmation
//   3. 联网验证标记: 提案先标记需联网验证（§3.4 Lv3），验证后附来源
//   4. 人工确认路径: 提案只有 confirm 后才写入 references/（二级边界，防规则漂移）
//   5. 两级边界: 自动经验只进 data/；规则确认后才进 references/
// 目录可注入: --dir <path> 测试用临时目录
// 用法:
//   node scripts/evolve.mjs add-failure --prompt <text> --diagnosis <text> --fix <text>
//   node scripts/evolve.mjs propose --threshold 3          # 每 3 条失败生成提案
//   node scripts/evolve.mjs list-proposals
//   node scripts/evolve.mjs confirm --proposal <id>        # 人工确认 → 标记 rules_ready
//   node scripts/evolve.mjs stats
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ensureDir, ts } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "data", "experience");
const FAILURES_SUB = "failures";
const PROPOSALS_FILE = "proposals.json";

// ensureDir / ts 由 lib.mjs 提供（消除跨脚本重复）
function hash(text) { return createHash("sha256").update(String(text)).digest("hex").slice(0, 10); }

// ================= 失败案例库 =================
function failuresDir(dir) { return join(dir, FAILURES_SUB); }

export function addFailure({ dir = DEFAULT_DIR, prompt, diagnosis, fix }) {
  if (!prompt || !diagnosis || !fix) throw new Error("add-failure 需要 prompt + diagnosis + fix（无诊断不入库，防垃圾数据）");
  ensureDir(failuresDir(dir));
  const id = `fail-${ts()}-${hash(prompt)}`;
  const record = { id, prompt, diagnosis, fix, ts: ts(), status: "logged" };
  writeFileSync(join(failuresDir(dir), `${id}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

export function listFailures({ dir = DEFAULT_DIR } = {}) {
  const d = failuresDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      // fail-safe：损坏 JSON 优雅跳过，不拖垮列表（与 version-store 容错一致）
      try {
        return JSON.parse(readFileSync(join(d, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

// ================= 经验提案（二级边界核心） =================
function proposalsPath(dir) { return join(dir, PROPOSALS_FILE); }

function loadProposals(dir) {
  if (!existsSync(proposalsPath(dir))) return [];
  try { return JSON.parse(readFileSync(proposalsPath(dir), "utf8")); } catch { return []; }
}

function saveProposals(dir, list) {
  ensureDir(dir);
  writeFileSync(proposalsPath(dir), JSON.stringify(list, null, 2) + "\n", "utf8");
}

// 聚类：把失败案例按诊断关键词聚类，形成提案
function cluster(failures) {
  const groups = new Map();
  for (const f of failures) {
    // 用诊断前 12 字做聚类键（粗聚类）
    const key = (f.diagnosis || "").slice(0, 12);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    count: items.length,
    examples: items.slice(0, 3).map((f) => ({ prompt: f.prompt.slice(0, 60), fix: f.fix.slice(0, 60) })),
  }));
}

export function proposeRules({ dir = DEFAULT_DIR, threshold = 3 }) {
  const failures = listFailures({ dir });
  if (failures.length < threshold) {
    return { proposed: 0, note: `失败案例 ${failures.length} 条 < 阈值 ${threshold}，暂不提案` };
  }
  const proposals = loadProposals(dir);
  const clusters = cluster(failures);
  let added = 0;
  for (const c of clusters) {
    if (c.count < 2) continue; // 单例不提案（防噪声）
    const existing = proposals.some((p) => p.cluster_key === c.key);
    if (existing) continue;
    const proposal = {
      id: `prop-${ts()}-${hash(c.key)}`,
      cluster_key: c.key,
      count: c.count,
      examples: c.examples,
      status: "needs_confirmation",
      needs_online_verification: true, // 提案先联网验证（§3.4 Lv3）
      verification: { done: false, source: null, confidence: null },
      created_ts: ts(),
    };
    proposals.push(proposal);
    added++;
  }
  saveProposals(dir, proposals);
  return { proposed: added, total: proposals.length, note: "提案已标记 needs_confirmation + needs_online_verification" };
}

export function listProposals({ dir = DEFAULT_DIR, status } = {}) {
  const all = loadProposals(dir);
  return status ? all.filter((p) => p.status === status) : all;
}

// 联网验证标记：验证完成后附来源（来源由宿主 web_search/人工确认注入）
export function markVerified({ dir = DEFAULT_DIR, proposal, source, confidence }) {
  const list = loadProposals(dir);
  const p = list.find((x) => x.id === proposal);
  if (!p) throw new Error(`提案不存在: ${proposal}`);
  p.verification = { done: true, source, confidence: confidence ?? "medium" };
  p.status = p.status === "needs_confirmation" ? "verified_pending_confirm" : p.status;
  saveProposals(dir, list);
  return p;
}

// 人工确认：确认后才允许写 references/（二级边界，防规则漂移）
export function confirmProposal({ dir = DEFAULT_DIR, proposal, confirm = true }) {
  const list = loadProposals(dir);
  const p = list.find((x) => x.id === proposal);
  if (!p) throw new Error(`提案不存在: ${proposal}`);
  if (p.verification.done !== true) throw new Error("提案必须先联网验证（markVerified）才能确认");
  p.status = confirm ? "rules_ready" : "rejected";
  p.confirmed_ts = ts();
  p.confirmed_by = "human";
  saveProposals(dir, list);
  return {
    ...p,
    note: confirm
      ? "已人工确认 → 可写入 references/（规则变更须过 evals/ 全部回归）"
      : "已拒绝，不进入 references/",
  };
}

export function stats({ dir = DEFAULT_DIR } = {}) {
  const failures = listFailures({ dir });
  const proposals = loadProposals(dir);
  return {
    failures: failures.length,
    proposals: proposals.length,
    pending_confirm: proposals.filter((p) => p.status.includes("pending") || p.status === "needs_confirmation").length,
    rules_ready: proposals.filter((p) => p.status === "rules_ready").length,
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
  const cmd = args[0];
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const dir = opt("dir") || DEFAULT_DIR;
  const wantJson = args.includes("--json");

  try {
    let out;
    switch (cmd) {
      case "add-failure":
        out = addFailure({ dir, prompt: opt("prompt"), diagnosis: opt("diagnosis"), fix: opt("fix") });
        break;
      case "propose":
        out = proposeRules({ dir, threshold: opt("threshold") ? Number(opt("threshold")) : 3 });
        break;
      case "list-proposals":
        out = listProposals({ dir, status: opt("status") });
        break;
      case "verify":
        out = markVerified({ dir, proposal: opt("proposal"), source: opt("source"), confidence: opt("confidence") });
        break;
      case "confirm":
        out = confirmProposal({ dir, proposal: opt("proposal"), confirm: opt("confirm") !== "false" });
        break;
      case "stats":
        out = stats({ dir });
        break;
      default:
        throw new Error("用法: add-failure|propose|list-proposals|verify|confirm|stats（--dir 可注入）");
    }
    if (wantJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else if (cmd === "stats") console.log(JSON.stringify(out, null, 2));
    else if (cmd === "propose") console.log(`提案: ${out.proposed} 条新增（共 ${out.total}）— ${out.note}`);
    else if (cmd === "confirm") console.log(`[${out.id}] ${out.note}`);
    else if (cmd === "add-failure") console.log(`失败案例已入库: ${out.id}`);
    else console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
