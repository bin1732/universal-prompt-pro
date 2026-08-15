#!/usr/bin/env node
// sem-score.mjs — Q-Score 语义 4 维确定性评分引擎（P5+ 补全）
// 维度: Fit 环境适配 15% / Economy 用词经济 10% / Verifiability 可证伪 15% / Safety 安全 10%
// 设计原则:
//   1. 确定性: 纯规则, 同输入恒同输出（与结构 4 维一致）
//   2. 复用: Economy 复用 token-count.mjs, Safety 复用 scan-safety.mjs（不重复造轮子）
//   3. 证据引用: 每条评分附原文 + 规则名
//   4. 诚实边界: Fit 依赖环境指纹, 指纹缺失时降级并标注"置信度低"（不假装精确）
// 用法:
//   node scripts/sem-score.mjs <prompt.txt> --fp '{"model_family":"claude","task_type":"代码"}'
//   node scripts/sem-score.mjs <prompt.txt> --fp '...' --json
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clamp } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 复用引擎（懒加载）
let tokenMod = null, scanMod = null;
async function getModules() {
  if (!tokenMod) tokenMod = await import(`file://${join(ROOT, "scripts", "token-count.mjs").replace(/\\/g, "/")}`);
  if (!scanMod) scanMod = await import(`file://${join(ROOT, "scripts", "scan-safety.mjs").replace(/\\/g, "/")}`);
  return { token: tokenMod, scan: scanMod };
}

// clamp 由 lib.mjs 提供（消除跨脚本重复）

// ================= Fit 环境适配（与 build-prompt.mjs MODEL_STYLE/TEMPLATE_ROUTE 对齐） =================
// 校验提示词是否包含目标模型族的方言信号 + 目标模板的结构信号
// penalty: 方言缺失扣分（默认 40；weak=弱信号模型族缺失只扣 20，诚实标注方言难以确认）
const DIALECT_SIGNALS = {
  // claude：白名单自定义 XML 标签（build-prompt 实际生成的标签）；排除 HTML 标准标签防误判
  claude:   { has: /<(role|task|format|context|input|output|instructions|rules|grounding|boundary|schema|examples|user_content)>/, label: "Claude 方言（XML 自定义标签）", penalty: 40 },
  gpt:      { has: /## |^#{1,3} /m, label: "GPT 方言（Markdown 标题）", penalty: 40 },
  gemini:   { has: /## |^#{1,3} /m, label: "Gemini 方言（结构化标题）", penalty: 40 },
  // 国产模型族：中文简洁指令是弱信号——【】或中文冒号分节均可；缺失只扣 20 并标注"方言难以确认"
  deepseek: { has: /(?=.*【)|(?=.*(?:任务|目标|输出|格式|规则)[：:])/, label: "DeepSeek 方言（中文分段/冒号分节）", penalty: 20, weak: true },
  doubao:   { has: /(?=.*【)|(?=.*(?:任务|目标|输出|格式|规则)[：:])/, label: "豆包方言（中文分段/冒号分节）", penalty: 20, weak: true },
  glm:      { has: /(?=.*【)|(?=.*(?:任务|目标|输出|格式|规则)[：:])/, label: "GLM 方言（中文分段/冒号分节）", penalty: 20, weak: true },
  qwen:     { has: /(?=.*【)|(?=.*(?:任务|目标|输出|格式|规则)[：:])/, label: "Qwen 方言（中文分段/冒号分节）", penalty: 20, weak: true },
  kimi:     { has: /(?=.*【)|(?=.*(?:任务|目标|输出|格式|规则)[：:])/, label: "Kimi 方言（中文分段/冒号分节）", penalty: 20, weak: true },
  open:     { has: /## |^#{1,3} /m, label: "开源模型方言（保守 Markdown）", penalty: 40 },
};

const TASK_SIGNALS = {
  RISEN:    ["步骤", "终点", "完成标准"],
  COSTAR:   ["背景", "目标", "受众"],
  SCHEMA:   ["JSON", "输出为", "null"],
  FEWSHOT:  ["示例", "类别"],
  REACT:    ["工具", "停止条件", "权限"],
  RAG:      ["引用", "无法从", "上下文"],
  VISION:   ["主体", "构图", "画幅"],
  SOCRATIC: ["引导", "提问", "学习者"],
  DECISION: ["方案", "权重", "评分"],
  RTF:      ["任务：", "输出格式"],
  CRISPE:   ["个性", "角色", "洞见"],
  COT:      ["逐步思考", "步骤"],
  DIALOGUE: ["对话角色", "每轮回复"],
  AGENT:    ["能力边界", "行为规则"],
  TOOLCALL: ["函数", "参数"],
  MCP:      ["工具名", "参数"],
  PIPELINE: ["处理阶段", "错误处理"],
  CLASSIFY: ["类别白名单", "兜底类别"],
  BRAINSTORM: ["主题", "数量要求"],
  SYNTHESIS: ["材料", "综合"],
};

export async function scoreFit(prompt, fp = {}) {
  const modelFamily = fp.model_family;
  const template = fp.template; // 期望模板（可选）
  const findings = [];
  const notes = [];

  if (!modelFamily) {
    return { score: null, confidence: "low", findings, notes: ["缺少 model_family，Fit 无法判定（置信度低）"] };
  }

  let score = 100;
  // 1. 方言匹配（penalty 可配置：强信号 40 / 弱信号 20）
  const sig = DIALECT_SIGNALS[modelFamily];
  if (sig) {
    if (sig.has.test(prompt)) {
      notes.push(`方言匹配：检测到 ${sig.label}`);
    } else {
      score -= sig.penalty || 40;
      findings.push({ type: "miss", rule: `缺少 ${sig.label}`, quote: null, line: null });
      if (sig.weak) notes.push("该模型族方言为弱信号（中文简洁指令），缺失扣分从轻（诚实边界）");
    }
  }

  // 2. 模板结构信号（±30）
  if (template && TASK_SIGNALS[template]) {
    const signals = TASK_SIGNALS[template];
    const hitCount = signals.filter((s) => prompt.includes(s)).length;
    const ratio = hitCount / signals.length;
    if (ratio >= 0.6) notes.push(`模板信号命中 ${hitCount}/${signals.length}（${template}）`);
    else {
      score -= 30;
      findings.push({ type: "miss", rule: `缺少 ${template} 模板结构信号（命中 ${hitCount}/${signals.length}）`, quote: null, line: null });
    }
  } else if (template) {
    notes.push(`模板 ${template} 无信号表，跳过结构校验（诚实边界）`);
  }

  return { score: clamp(score), confidence: "high", findings, notes };
}

// ================= Verifiability 可证伪 =================
const VERIF_RULES = [
  { re: /完成标准|验收条件|验收标准|done when|acceptance criteria/i, label: "成功标准/验收条件", points: 30 },
  { re: /自检|检查.{0,6}(每一步|结果|输出)|验证输出/i, label: "自检步骤", points: 25 },
  { re: /不要编造|注明来源|引用|无法确定.{0,6}(时|就|则)|无法(从|回答)|grounded|cite source/i, label: "防幻觉锚点", points: 25 },
  { re: /如果|当.{0,8}时|若.{0,8}(则|就|按|处理)|[\u4e00-\u9fff]{1,8}时(回复|输出|返回|按|就|处理)/, label: "条件分支处理", points: 20 },
  { re: /加权总分|总分表|推荐与理由|逐维打分|打分\(1-5\)|敏感性|权重变化|±\d+%|决策依据/i, label: "决策可证伪（加权打分/推荐依据/敏感性）", points: 20 },
];

export function scoreVerifiability(prompt) {
  const findings = [];
  let score = 0;
  for (const r of VERIF_RULES) {
    if (r.re.test(prompt)) {
      score += r.points;
      const m = prompt.match(r.re);
      const lineNo = m ? prompt.slice(0, m.index).split("\n").length : 1;
      findings.push({ type: "hit", rule: r.label, quote: (m ? m[0] : "").slice(0, 30), line: lineNo });
    }
  }
  return { score: clamp(score), findings: findings.slice(0, 6), notes: [] };
}

// ================= Economy 用词经济（复用 token-count） =================
export async function scoreEconomy(prompt, targetBudget) {
  const { token } = await getModules();
  const red = token.detectRedundancy(prompt);
  const bud = token.budgetReport(prompt, targetBudget);
  let score = 100;
  const findings = [];
  const notes = [];

  // 冗余扣分：每处 -8（上限 -40）
  const redCount = red.findings.length;
  if (redCount) {
    score -= Math.min(40, redCount * 8);
    notes.push(`冗余 ${redCount} 处（重复/套话/堆叠）`);
    findings.push(...red.findings.slice(0, 3).map((f) => ({ type: "hit", rule: f.rule, quote: f.quote, line: f.line })));
  }

  // 预算偏差：超预算扣分
  if (bud.deviation_pct != null) {
    if (bud.deviation_pct > 0) {
      const over = Math.min(30, Math.round(bud.deviation_pct / 5)); // 每超 5% 扣 1，上限 30
      score -= over;
      notes.push(`超预算 ${bud.deviation_pct}%（扣 ${over}）`);
    } else {
      notes.push(`预算内（偏差 ${bud.deviation_pct}%）`);
    }
  } else {
    notes.push("未指定预算，仅按冗余评估");
  }

  return { score: clamp(score), findings, notes };
}

// ================= Safety 安全（复用 scan-safety） =================
export async function scoreSafety(prompt) {
  const { scan } = await getModules();
  const r = scan.scanSafety(prompt);
  const findings = r.hits.slice(0, 4).map((h) => ({ type: "hit", rule: h.rule, quote: h.quote, line: h.line }));
  let score;
  switch (r.level) {
    case "red": score = 0; break;
    case "yellow": score = 50; break;
    case "gray": score = 70; break;
    default: score = 100;
  }
  return { score, findings, notes: [`扫描级别: ${r.level}`] };
}

// ================= 主入口 =================
export async function scoreSemantic(prompt, opts = {}) {
  if (!prompt || !prompt.trim()) throw new Error("输入为空");
  const { fp = {}, target_budget } = opts;
  const [fit, econ, verif, safety] = await Promise.all([
    scoreFit(prompt, fp),
    scoreEconomy(prompt, target_budget),
    Promise.resolve(scoreVerifiability(prompt)),
    scoreSafety(prompt),
  ]);
  return { fit, economy: econ, verifiability: verif, safety };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const fpIdx = args.indexOf("--fp");
  const fp = fpIdx >= 0 ? JSON.parse(args[fpIdx + 1]) : {};
  const budgetIdx = args.indexOf("--budget");
  const targetBudget = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : null;
  const fileArg = args.find((a) => !a.startsWith("--") && !a.startsWith("{") && !a.startsWith("[") && !/^-?\d+$/.test(a));
  let input;
  if (fileArg) input = readFileSync(fileArg, "utf8");
  else input = readFileSync(0, "utf8");

  const r = await scoreSemantic(input, { fp, target_budget: targetBudget });
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    const dims = { Fit: r.fit, Economy: r.economy, Verifiability: r.verifiability, Safety: r.safety };
    for (const [name, d] of Object.entries(dims)) {
      const weight = { Fit: 15, Economy: 10, Verifiability: 15, Safety: 10 }[name];
      console.log(`[${name} 语义(${weight}%)] ${d.score == null ? "无法判定(缺环境)" : d.score + "/100"}`);
      for (const f of d.findings) {
        if (f.line != null) console.log(`   - [证据] 第${f.line}行 "${f.quote}" ← ${f.rule}`);
        else console.log(`   - [缺失] ${f.rule}`);
      }
      for (const n of d.notes) console.log(`   - [说明] ${n}`);
    }
  }
}
