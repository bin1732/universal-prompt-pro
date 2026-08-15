#!/usr/bin/env node
// score-prompt.mjs — Q-Score 结构 4 维确定性评分引擎（P1）
// 维度: Clarity 15 / Specificity 15 / Structure 10 / Robustness 10（合计权重 50%，语义 4 维由 LLM 判定）
// 设计原则:
//   1. 确定性: 纯规则匹配, 无随机, 同一输入恒得同一输出 (P1 可复现)
//   2. 证据引用: 每条扣分/加分必须带原文引用 + 命中规则 (P1 禁止裸分数)
// 用法:
//   node scripts/score-prompt.mjs <prompt.txt>       # 人类可读报告
//   node scripts/score-prompt.mjs <prompt.txt> --json # 机器可读
//   echo "提示词文本" | node scripts/score-prompt.mjs
import { readFileSync } from "node:fs";
import { clamp } from "./lib.mjs";

// ================= 规则库（中英双语） =================

const RULES = {
  clarity: {
    vagueVerbs: [
      { re: /帮\s*我\s*(弄|搞|整|处理|看|改|写|做)/, label: "模糊任务动词（帮我弄/搞/处理…）" },
      { re: /(弄|搞|整)\s*一?\s*下/, label: "模糊动词（弄一下/搞一下/整一下）" },
      { re: /\b(help me (fix|handle|do|make|improve)|make it better|improve this)\b/i, label: "英文模糊动词（help me fix / make it better…）" },
      { re: /(看看|试试|随便|大概|差不多)/, label: "模糊程度词（看看/试试/随便…）" },
    ],
    ambiguousPronouns: [
      { re: /\b(它|他|她|这个|那个|这些|那些)\b/, label: "可能指代不明的代词（它/这个/那个…）" },
      { re: /\b(it|this|these|those|they)\b|\bthat\b(?![\t ]*(?:are|is|have|has|was|were|will|can|could|should|would|do|does|did|make|makes|produce|contain|include|exist|occur|not|are))/i, label: "可能指代不明的英文代词（this/that/it…）" },
    ],
    multiTask: [
      { re: /(并且|同时|还要|顺便).{0,30}(写|生成|分析|总结|翻译|计算)/, label: "多任务无优先级（并且/同时…还要…）" },
      { re: /(写|生成).{0,20}(并且|同时|还要).{0,20}(写|生成|分析)/, label: "一稿多任务" },
    ],
  },
  specificity: {
    vagueAdjectives: [
      { re: /\b(清晰|专业|完整|详细|好|高质量|高效|准确|优秀|合理|合适|美观|简洁|全面|充分|认真|漂亮)\b/, label: "无测量对象的形容词（清晰/专业/完整…）" },
      { re: /\b(clear|professional|complete|detailed|good|high[- ]quality|efficient|accurate|excellent|nice|beautiful|simple|comprehensive|proper)\b/i, label: "英文无测量对象形容词（clear/good/nice…）" },
    ],
    constraintTypes: [
      { re: /格式|用.{0,10}(形式|格式)|JSON|Markdown|表格|列表|步骤|分点|Output:|output:|Format:|format:/, label: "输出格式约束" },
      { re: /不超过|字数|长度|以内|至少|最多|简短|200 字|200字|max\s*\d+\s*(words|characters)|at most|within\s*\d+|word limit/, label: "长度约束" },
      { re: /范围|仅限|只讨论|领域|面向|受众|目标用户/, label: "范围/受众约束" },
      { re: /语气|风格|口吻|正式|轻松|专业地|tone|style/, label: "语气/风格约束" },
      { re: /示例|例如|比如|参考例子|for example|e\.g\./, label: "示例约束" },
      { re: /输出为|返回|只输出|以.{0,10}(格式|形式)|输出\s*(JSON|数组|列表|表格|结果)|numbered list|bulleted list/, label: "输出形式约束" },
      { re: /引用|来源|编号|cite|source|reference/, label: "引用/来源约束" },
      { re: /先给|再列|首先|然后|按顺序|顺序/, label: "结构/顺序约束" },
      { re: /工具|停止条件|权限|白名单|黑名单|循环|工作流|工作循环/, label: "agentic 结构约束（工具/停止条件/权限）" },
      { re: /候选方案|备选方案|评估维度|权重|打分|敏感性|权衡|取舍|对比分析/, label: "决策结构约束（候选方案/评估维度/权重）" },
    ],
  },
  structure: {
    role: [
      { re: /你是一个|你是|你扮演|扮演|角色|作为|as an?\s+\w+ (engineer|expert|writer|assistant)|you are an? /i, label: "角色设定" },
    ],
    task: [
      { re: /^(请|麻烦|帮我)?\s*(写|生成|创建|分析|总结|翻译|计算|重构|设计|评估|列出|解释|优化|回答|回复|解答|抽取|提取|选择|比较|判断|推荐|规划|实现|配置|维护|监控|部署|测试|运行|审查|调试|迁移|make|create|write|analyze|summarize|translate|calculate|refactor|design|explain|review|answer|extract|choose|select|compare|judge|recommend|plan|implement|deploy|test|run|monitor)(?=[\s，。；：、（(：;,:]|[\u4e00-\u9fff]|$)/im, label: "明确任务指令（行首祈使动词）" },
      { re: /(?<=[。；;：:．.!?！？]\s*|\n)(?:请|麻烦|需|需要)?\s*[\u4e00-\u9fff]{0,10}?(?:抽取|提取|回答|回复|解答|生成|创建|分析|总结|翻译|计算|设计|评估|列出|解释|优化|重构|选择|比较|判断|推荐|规划|实现|配置|维护|监控|部署|测试|运行|审查|调试|迁移|write|make|create|analyze|summarize|translate|calculate|refactor|design|explain|review|answer|extract|choose|select|compare|recommend|plan|implement|deploy|test|run)(?=[\s，。；：、（(：;,:]|[\u4e00-\u9fff]|$)/i, label: "明确任务指令（句中祈使动词）" },
    ],
    format: [
      { re: /格式|输出为|返回|用.{0,10}(形式|格式)|JSON|Markdown|表格|以.{0,10}呈现|Output:|output:|Format:|format:|结构：|分点|按以下结构/, label: "输出格式说明" },
    ],
  },
  robustness: {
    edgeSignals: [
      { re: /如果|当.{0,10}时|若|遇到|没有|缺失|为空|空值|null|undefined|无法|不确定|边界|例外|特殊情况/, label: "边界条件提及（如果/当…/无法…）" },
      { re: /\b(if|when|empty|null|undefined|missing|unknown|edge case|exception|default)\b/i, label: "英文边界条件（if/when/empty…）" },
      { re: /不要编造|不要虚构|不编造|注明来源|标注引用|do not (invent|make up|fabricate)|don'?t (invent|make up)|cite source/i, label: "防幻觉锚点（不要编造/注明来源…）" },
      { re: /敏感性|权重变化|±\d+%|不一致|冲突|取舍|权衡|代价|不推荐/i, label: "决策敏感性/冲突处理（权重变化/代价/取舍）" },
    ],
    fallback: [
      { re: /无法.{0,10}(时|就|则)|不确定.{0,10}(时|就|则)|默认|否则|就输出|回退|fallback|otherwise|default/i, label: "显式兜底指令（无法…则/默认/否则…）" },
    ],
  },
};

// ================= 评分实现（确定性） =================

function findHits(text, ruleGroup) {
  const hits = [];
  for (const rule of ruleGroup) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      const lineNo = text.slice(0, idx).split("\n").length;
      const quote = (m[0] || text.slice(idx, idx + 20)).trim().slice(0, 40);
      hits.push({ rule: rule.label, quote, line: lineNo });
      if (re.lastIndex === idx) re.lastIndex++; // 防零宽死循环
      if (hits.length >= 10) break;
    }
    if (hits.length >= 10) break;
  }
  return hits;
}

// clamp 由 lib.mjs 提供（消除跨脚本重复）

// 统一证据格式: {score, findings:[{type:'hit'|'missing', rule, quote?, line?}], notes:[str]}
function scoreClarity(text) {
  const vague = findHits(text, RULES.clarity.vagueVerbs);
  const pronouns = findHits(text, RULES.clarity.ambiguousPronouns);
  const multi = findHits(text, RULES.clarity.multiTask);
  let score = 100;
  const findings = [];
  if (vague.length) { score -= 25; findings.push(...vague.map((h) => ({ ...h, type: "hit", dim: "模糊任务动词" }))); }
  if (pronouns.length) { score -= 10; findings.push(...pronouns.map((h) => ({ ...h, type: "hit", dim: "指代不明代词" }))); }
  if (multi.length) { score -= 30; findings.push(...multi.map((h) => ({ ...h, type: "hit", dim: "多任务无优先级" }))); }
  return { score: clamp(score), findings: findings.slice(0, 6), notes: [] };
}

function scoreSpecificity(text) {
  const adjectives = findHits(text, RULES.specificity.vagueAdjectives);
  const constraints = findHits(text, RULES.specificity.constraintTypes);
  // PromptEval 实测: specificity 是最常见失败, 基准压低
  let score = 30;
  const findings = [];
  const notes = [];
  score += Math.min(60, constraints.length * 15); // 每类约束 +15, 上限 +60
  if (constraints.length) {
    notes.push(`检测到 ${constraints.length} 类约束`);
    findings.push(...constraints.map((h) => ({ ...h, type: "hit", dim: "约束" })));
  }
  score -= Math.min(50, adjectives.length * 10);  // 每个模糊形容词 -10, 上限 -50
  if (adjectives.length) {
    notes.push(`检测到 ${adjectives.length} 个无测量对象形容词`);
    findings.push(...adjectives.map((h) => ({ ...h, type: "hit", dim: "无测量形容词" })));
  }
  return { score: clamp(score), findings: findings.slice(0, 8), notes };
}

function scoreStructure(text) {
  const role = findHits(text, RULES.structure.role);
  const task = findHits(text, RULES.structure.task);
  const format = findHits(text, RULES.structure.format);
  let score = 100;
  const findings = [];
  // 空泛角色检测：仅"你是助手/AI/机器人"等无领域指向的角色不算有效角色（C-14 类缺陷修复）
  const genericRole = /(你是一个?)(助手|AI|机器人|智能体|助理)([。；;\s]|$)/i.test(text) && !/资深|专业|领域|工程师|记者|律师|导师|专家/.test(text);
  if (!role.length || genericRole) { score -= 25; findings.push({ type: "missing", rule: "缺少角色设定（或角色为空泛无领域指向）" }); }
  if (!task.length) { score -= 30; findings.push({ type: "missing", rule: "缺少明确任务指令" }); }
  if (!format.length) { score -= 20; findings.push({ type: "missing", rule: "缺少输出格式说明" }); }
  if (task.length && format.length && task[0].line > format[0].line) {
    score -= 15;
    findings.push({ type: "missing", rule: "格式说明出现在任务指令之前（顺序异常）" });
  }
  return { score: clamp(score), findings, notes: [] };
}

function scoreRobustness(text) {
  const edges = findHits(text, RULES.robustness.edgeSignals);
  const fallback = findHits(text, RULES.robustness.fallback);
  let score = 30;
  const findings = [];
  const notes = [];
  score += Math.min(50, edges.length * 25); // 每类边界信号 +25, 上限 +50
  if (edges.length) {
    notes.push(`检测到 ${edges.length} 处边界条件信号`);
    findings.push(...edges.map((h) => ({ ...h, type: "hit", dim: "边界信号" })));
  }
  if (fallback.length) {
    score += 20;
    notes.push("存在显式兜底指令");
    findings.push(...fallback.map((h) => ({ ...h, type: "hit", dim: "兜底指令" })));
  }
  return { score: clamp(score), findings: findings.slice(0, 6), notes };
}

// ================= 主入口 =================

const WEIGHTS = { clarity: 0.15, specificity: 0.15, structure: 0.10, robustness: 0.10 };
const STRUCTURAL_WEIGHT = 0.50;

export function scorePrompt(text) {
  if (!text || !text.trim()) {
    throw new Error("输入为空：请提供提示词文本（文件参数或 stdin）");
  }
  const clarity = scoreClarity(text);
  const specificity = scoreSpecificity(text);
  const structure = scoreStructure(text);
  const robustness = scoreRobustness(text);

  // 结构子集加权分（仅 4 维, 按其权重归一化到 0-100）
  const weighted = clarity.score * WEIGHTS.clarity + specificity.score * WEIGHTS.specificity +
                   structure.score * WEIGHTS.structure + robustness.score * WEIGHTS.robustness;
  const structuralScore = Math.round(weighted / STRUCTURAL_WEIGHT);

  return {
    meta: {
      engine: "score-prompt.mjs v1.0.0",
      mode: "structural-only",
      structural_weight: STRUCTURAL_WEIGHT,
      note: "语义 4 维（Fit/Economy/Verifiability/Safety）由 LLM 判定，占剩余 50%",
    },
    dimensions: { clarity, specificity, structure, robustness },
    structural_score: structuralScore,
    band: structuralScore < 55 ? "需重写" : structuralScore < 70 ? "定向修补" : structuralScore < 85 ? "可用" : "优秀",
  };
}

function printFindings(findings) {
  for (const f of findings || []) {
    if (f.type === "missing") {
      console.log(`   - [缺失] ${f.rule}`);
    } else if (f.line) {
      console.log(`   - [证据] 第${f.line}行 "${f.quote}" ← ${f.rule}`);
    }
  }
}

// CLI 入口
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const fileArg = args.find((a) => !a.startsWith("--") && !a.startsWith("{") && !a.startsWith("[") && !/^-?\d+$/.test(a));
  let input;
  if (fileArg) {
    input = readFileSync(fileArg, "utf8");
  } else {
    input = readFileSync(0, "utf8"); // stdin
  }
  const result = scorePrompt(input);
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log("=== Q-Score 结构维度评分 ===");
    console.log(`结构维度得分: ${result.structural_score}/100（权重 ${result.meta.structural_weight * 100}%）`);
    console.log(`分数带: ${result.band}`);
    console.log("");
    const d = result.dimensions;
    for (const key of ["clarity", "specificity", "structure", "robustness"]) {
      const dim = d[key];
      const name = { clarity: "Clarity 清晰(15%)", specificity: "Specificity 具体(15%)", structure: "Structure 结构(10%)", robustness: "Robustness 鲁棒(10%)" }[key];
      console.log(`[${name}] ${dim.score}/100`);
      printFindings(dim.findings);
      for (const n of dim.notes || []) console.log(`   - [说明] ${n}`);
    }
    console.log("");
    console.log("语义 4 维（Fit/Economy/Verifiability/Safety）待 LLM 判定，占 50%。");
  }
}
