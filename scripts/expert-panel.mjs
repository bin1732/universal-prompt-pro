#!/usr/bin/env node
// expert-panel.mjs — 专家团编排引擎（P5，检索增强型）
// 能力（采纳"事实走搜索、判断走 LLM"）:
//   1. 双档切换: 单核（默认，快省稳）/ 评审团（高风险/复杂/用户点名时）
//   2. 触发信号: 用户要求 / 生产场景 / Q-Score<55 / 多领域交叉
//   3. 专家阵容: 架构师(主控) + 情报员(检索,零 API key) + 领域专家 + 红队 + 安全官 + 仲裁
//   4. 意见→Q-Score 维度映射: 专家意见必须能映射到评分维度（否则视为不可用意见）
//   5. 仲裁: 分歧≥2 次必须有依据（不是和稀泥）
// 设计原则: 情报员走宿主 web_search（此处模拟为契约/占位，实际由宿主注入搜索能力）
// 目录可注入: --dir <path> 测试用临时目录
// 用法:
//   node scripts/expert-panel.mjs mode --score 78 --risk high
//   node scripts/expert-panel.mjs trigger --task "代码" --score 45 --user-request "请专家团评审"
//   node scripts/expert-panel.mjs panel --prompt <text> --score 78 --task 代码   # 模拟评审团流程
//   node scripts/expert-panel.mjs arbitrate --op1 '{"dim":"specificity","vote":62}' --op2 '{"dim":"specificity","vote":80}'
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "assets", "data", "versions");

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

// ================= 触发信号 =================
export function checkTrigger({ task, score, userRequest, risk, multiDomain }) {
  const text = String(userRequest || "");
  const signals = [];
  if (text.includes("专家团") || text.includes("评审") || text.includes("panel")) signals.push("user_request");
  if (risk === "high" || risk === "production") signals.push("production");
  if (score != null && score < 55) signals.push("low_score");
  if (multiDomain) signals.push("multi_domain");
  // 领域交叉启发式：任务涉及多个领域关键词
  const domainPairs = [["医疗", "客服"], ["法律", "产品"], ["金融", "写作"]];
  const taskText = String(task || "");
  if (domainPairs.some(([a, b]) => taskText.includes(a) && taskText.includes(b))) signals.push("multi_domain_heuristic");
  return { triggered: signals.length > 0, signals, mode: signals.length > 0 ? "panel" : "single" };
}

// ================= 专家团流程（模拟编排：情报员检索契约 + 各专家意见） =================
const PANELISTS = [
  { role: "架构师", dims: ["structure", "clarity"], type: "judge" },
  { role: "情报员", dims: ["fit"], type: "search", note: "事实核查：模型最新能力/平台规范（宿主 web_search，零 API key；无搜索能力时降级为静态矩阵+标注可能过时）" },
  { role: "领域专家", dims: ["fit", "verifiability"], type: "judge" },
  { role: "对抗测试员", dims: ["robustness", "safety"], type: "judge" },
  { role: "安全合规官", dims: ["safety"], type: "judge" },
];

export function runPanel({ prompt, score, task }) {
  // 模拟：各专家产出意见（真实实现中由 subagent/LLM 提供；此处演示契约结构）
  const opinions = PANELISTS.map((p) => ({
    role: p.role,
    type: p.type,
    dims: p.dims,
    // 占位意见：真实调用时由宿主注入 LLM/subagent 输出
    opinion: p.type === "search"
      ? "【情报员·检索契约】搜索项: 目标模型最新 prompt 能力；来源+置信度标注（此处为占位，实际走 web_search）"
      : `【${p.role}】针对 ${p.dims.join("/")} 维提出意见（占位：由 LLM 判定，先列证据再给分）`,
  }));
  // 可用性校验：意见必须映射到 Q-Score 维度
  const unmapped = opinions.filter((o) => o.dims.some((d) => !Q_DIMS.includes(d)));
  return {
    panel_id: `panel-${ts()}`,
    prompt_preview: (prompt || "").slice(0, 60),
    input_score: score,
    task,
    opinions,
    mapping_ok: unmapped.length === 0,
    note: "评审团模式：专家并行意见 → 仲裁 → 修订 → 复评 → 输出（§7.3）",
  };
}

// ================= 仲裁 =================
export function arbitrate({ ops }) {
  if (!Array.isArray(ops) || ops.length < 2) throw new Error("仲裁需要 ≥2 条意见");
  const dims = [...new Set(ops.map((o) => o.dim))];
  const result = dims.map((dim) => {
    const votes = ops.filter((o) => o.dim === dim).map((o) => Number(o.vote));
    const avg = votes.reduce((a, b) => a + b, 0) / votes.length;
    const spread = Math.max(...votes) - Math.min(...votes);
    return {
      dim,
      votes,
      avg: Math.round(avg),
      spread,
      // 分歧≥2 次时必须有依据（此处以 spread 作为分歧度量）
      verdict: spread >= 20 ? { decided: false, reason: `分歧过大（极差 ${spread}），需补充依据或更多评委` } : { decided: true, value: Math.round(avg), reason: `取均值 ${avg}（极差 ${spread} < 20）` },
    };
  });
  return { arbitration: result, note: "仲裁必须有依据，不和稀泥（P5）" };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
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
        out = runPanel({ prompt: opt("prompt"), score: opt("score") != null ? Number(opt("score")) : null, task: opt("task") });
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
