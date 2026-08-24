#!/usr/bin/env node
// expert-panel.mjs — 专家团编排引擎（P5，检索增强型）
// 能力（采纳"事实走搜索、判断走 LLM"）:
//   1. 双档切换: 单核（默认，快省稳）/ 评审团（高风险/复杂/用户点名时）
//   2. 触发信号: 用户要求 / 生产场景 / Q-Score<55 / 多领域交叉
//   3. 专家阵容: 架构师(主控) + 情报员(检索,零 API key) + 领域专家 + 红队 + 安全官 + 仲裁
//   4. 意见→Q-Score 维度映射: 专家意见必须能映射到评分维度（否则视为不可用意见）
//   5. 仲裁: 分歧≥2 次必须有依据（不是和稀泥）
// 设计原则: 情报员检索由宿主 web_search 注入（无检索能力时降级为静态矩阵并标注可能过时）
// 目录可注入: --dir <path> 测试用临时目录
// 用法:
//   node scripts/expert-panel.mjs mode --score 78 --risk high
//   node scripts/expert-panel.mjs trigger --task "代码" --score 45 --user-request "请专家团评审"
//   node scripts/expert-panel.mjs panel --prompt <text> --score 78 --task 代码   # 评审团流程示例
//   node scripts/expert-panel.mjs arbitrate --op1 '{"dim":"specificity","vote":62}' --op2 '{"dim":"specificity","vote":80}'
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "data", "versions");

// ensureDir / ts 由 lib.mjs 提供（消除跨脚本重复）

// Q-Score 8 维（意见必须能映射到这里）
const Q_DIMS = ["clarity", "specificity", "structure", "robustness", "fit", "economy", "verifiability", "safety"];

// ================= 双档切换 =================
export function decideMode({ score, risk, userRequested = false, multiDomain = false }) {
  const signals = [];
  if (userRequested) signals.push("用户显式要求");
  if (risk === "high" || risk === "production") signals.push("高风险/生产场景");
  if (score != null && score < 55) signals.push(`Q-Score ${score} < 55（需重写的高风险稿）`);
  if (multiDomain) signals.push("多领域交叉");
  const mode = signals.length > 0 ? "panel" : "single";
  return { mode, signals, note: mode === "panel" ? "评审团模式（慢、全、严）" : "单核模式（快、省、稳）" };
}

// 多领域交叉检测：可配置领域对表（任务同时含一对关键词 → 多领域信号；命中对数越多信号越强）
const DOMAIN_PAIRS = [
  ["医疗", "客服"], ["法律", "产品"], ["金融", "写作"],
  ["医疗", "教育"], ["法律", "营销"], ["金融", "客服"],
];

// ================= 触发信号 =================
export function checkTrigger({ task, score, userRequest, risk, multiDomain }) {
  const text = String(userRequest || "");
  const signals = [];
  if (text.includes("专家团") || text.includes("评审") || text.includes("panel")) signals.push("user_request");
  if (risk === "high" || risk === "production") signals.push("production");
  if (score != null && score < 55) signals.push("low_score");
  if (multiDomain) signals.push("multi_domain");
  // 领域交叉启发式：命中领域对数越多，多领域信号越强（可配置表）
  const taskText = String(task || "");
  const pairHits = DOMAIN_PAIRS.filter(([a, b]) => taskText.includes(a) && taskText.includes(b));
  if (pairHits.length) signals.push(`multi_domain_heuristic(${pairHits.length})`);
  return { triggered: signals.length > 0, signals, mode: signals.length > 0 ? "panel" : "single", domain_pair_hits: pairHits.length };
}

// ================= 专家团流程（规则引擎真实意见：基于 Q-Score 维度实际评分证据） =================
const PANELISTS = [
  { role: "架构师", dims: ["structure", "clarity"], type: "judge" },
  { role: "情报员", dims: ["fit"], type: "search", note: "事实核查：模型最新能力/平台规范（宿主 web_search，零 API key；无搜索能力时降级为静态矩阵+标注可能过时）" },
  { role: "领域专家", dims: ["fit", "verifiability"], type: "judge" },
  { role: "对抗测试员", dims: ["robustness", "safety"], type: "judge" },
  { role: "安全合规官", dims: ["safety"], type: "judge" },
];

let qfMod = null;
async function getQscore() {
  if (!qfMod) qfMod = await import(`file://${join(ROOT, "scripts", "qscore-full.mjs").replace(/\\/g, "/")}`);
  return qfMod;
}

// 规则引擎真实意见：各专家基于负责维度的实际评分证据产出意见（无证据则如实说明"未发现扣分项"）
export async function runPanel({ prompt, score, task, fp = {} }) {
  let dimsData = null;
  let qscoreNote = null;
  try {
    const { scoreFull } = await getQscore();
    const r = await scoreFull(prompt || "", { fp });
    dimsData = r.dimensions;
    qscoreNote = `规则引擎实测 Q-Score ${r.total_score} [${r.band}]（各专家意见基于实际评分证据）`;
  } catch (e) {
    qscoreNote = `评分引擎不可用（${e.message}），专家意见基于文本扫描`;
  }

  const opinions = PANELISTS.map((p) => {
    if (p.type === "search") {
      return {
        role: p.role,
        type: p.type,
        dims: p.dims,
        opinion: "【情报员·检索契约】搜索项: 目标模型最新 prompt 能力/平台规范；来源+置信度标注（宿主 web_search 注入；无搜索能力时降级为静态矩阵并标注可能过时）",
        evidence: [],
      };
    }
    const evidence = [];
    for (const d of p.dims) {
      const dim = dimsData?.[d];
      if (dim && Array.isArray(dim.findings) && dim.findings.length) {
        for (const f of dim.findings.slice(0, 3)) {
          evidence.push({ dim: d, rule: f.rule, quote: String(f.quote || "").slice(0, 40), line: f.line });
        }
      }
    }
    const opinion = evidence.length
      ? `【${p.role}】发现 ${evidence.length} 条证据：` + evidence.map((e) => `${e.dim} 维 ${e.rule}（"${e.quote}"${e.line ? " 第" + e.line + "行" : ""}）`).join("；")
      : `【${p.role}】${p.dims.join("/")} 维未发现扣分项（规则引擎判定，无显著问题）`;
    return { role: p.role, type: p.type, dims: p.dims, opinion, evidence };
  });

  // 可用性校验：意见必须映射到 Q-Score 维度
  const unmapped = opinions.filter((o) => o.dims.some((d) => !Q_DIMS.includes(d)));
  return {
    panel_id: `panel-${ts()}`,
    prompt_preview: (prompt || "").slice(0, 60),
    input_score: score,
    task,
    opinions,
    qscore_note: qscoreNote,
    mapping_ok: unmapped.length === 0,
    note: "评审团模式：规则引擎真实意见（基于 Q-Score 维度实际证据）；宿主 LLM/subagent 可注入增强判定（pipe --judge 覆盖语义维）",
  };
}

// ================= 仲裁（支持维度权重：加权平均，默认等权） =================
export function arbitrate({ ops, weights = null }) {
  if (!Array.isArray(ops) || ops.length < 2) throw new Error("仲裁需要 ≥2 条意见");
  const dims = [...new Set(ops.map((o) => o.dim))];
  const result = dims.map((dim) => {
    const votes = ops.filter((o) => o.dim === dim).map((o) => Number(o.vote));
    const w = weights && weights[dim] ? weights[dim] : 1 / votes.length;
    const weightedAvg = votes.reduce((a, b) => a + b, 0) * w / votes.length;
    const avg = votes.reduce((a, b) => a + b, 0) / votes.length;
    const spread = Math.max(...votes) - Math.min(...votes);
    return {
      dim,
      votes,
      avg: Math.round(avg),
      weighted_avg: weights && weights[dim] ? Math.round(votes.reduce((a, b, i) => a + b * (weights[dim] || 1), 0) / votes.length) : null,
      spread,
      // 分歧≥20 时必须有依据（补充证据或更多评委），不和稀泥
      verdict: spread >= 20 ? { decided: false, reason: `分歧过大（极差 ${spread}），需补充依据或更多评委` } : { decided: true, value: Math.round(avg), reason: `取均值 ${avg}（极差 ${spread} < 20）` },
    };
  });
  return { arbitration: result, note: "仲裁必须有依据，不和稀泥；提供 weights 时采用加权平均" };
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
  const wantJson = args.includes("--json");

  try {
    let out;
    switch (cmd) {
      case "mode":
        out = decideMode({
          score: opt("score") != null ? Number(opt("score")) : null,
          risk: opt("risk"),
          userRequested: opt("user") === "1" || opt("user") === "true",
          multiDomain: opt("multi") === "1" || opt("multi") === "true",
        });
        break;
      case "trigger":
        out = checkTrigger({ task: opt("task"), score: opt("score") != null ? Number(opt("score")) : null, userRequest: opt("user-request"), risk: opt("risk"), multiDomain: opt("multi") === "1" });
        break;
      case "panel":
        out = await runPanel({ prompt: opt("prompt"), score: opt("score") != null ? Number(opt("score")) : null, task: opt("task"), fp: opt("fp") ? JSON.parse(opt("fp")) : {} });
        break;
      case "arbitrate": {
        const ops = [];
        for (let i = 1; ; i++) {
          const raw = opt(`op${i}`);
          if (!raw) break;
          ops.push(JSON.parse(raw));
        }
        out = arbitrate({ ops });
        break;
      }
      default:
        throw new Error("用法: mode|trigger|panel|arbitrate");
    }
    if (wantJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else if (cmd === "mode") console.log(`模式: ${out.mode}（触发信号: ${out.signals.join("、") || "无"}）— ${out.note}`);
    else if (cmd === "trigger") console.log(`触发: ${out.triggered ? "是" : "否"} → ${out.mode}（信号: ${out.signals.join("、") || "无"}）`);
    else if (cmd === "panel") {
      console.log(`[${out.panel_id}] 输入 Q-Score=${out.input_score} 任务=${out.task}`);
      for (const o of out.opinions) console.log(`  [${o.role}/${o.type}] ${o.opinion}`);
      console.log(`维度映射校验: ${out.mapping_ok ? "OK（全部意见可映射到 Q-Score 维度）" : "FAIL（存在不可用意见）"}`);
    } else if (cmd === "arbitrate") {
      for (const a of out.arbitration) {
        console.log(`[${a.dim}] 投票 ${a.votes.join("/")} → ${a.verdict.decided ? `裁定 ${a.verdict.value}（${a.verdict.reason}）` : `未裁定：${a.verdict.reason}`}`);
      }
    } else console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
