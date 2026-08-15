#!/usr/bin/env node
// build-prompt.mjs — 构建引擎（P2）
// 流程: 环境指纹 → 模板路由 → 技术选择 → 组装输出 + 情报检索建议
// 设计原则:
//   1. 确定性: 同指纹+同需求 → 同输出（可测试）
//   2. 环境优先: 缺失指纹字段不猜测, 标记 fit 不完整（P2）
//   3. 方言适配: 按模型族输出结构语法（XML/Markdown/中文简洁）
//   4. 情报检索: 输出"需 web_search 核实"的建议清单（关键节点才搜, §3.4）
// 用法:
//   node scripts/build-prompt.mjs <fingerprint.json>     # 从文件读指纹
//   cat fingerprint.json | node scripts/build-prompt.mjs # 或 stdin
// 指纹 JSON 字段: model_family, model_version?, platform_form, task_type,
//                 context_budget?, user_level?, language?, goal_verifiability?, request
import { readFileSync } from "node:fs";

// ================= 模板路由表（与 references/environment-matrix.md §4 对齐） =================
// P1-1 补全：原 12 类仅覆盖 12 个模板，AGENT/MCP/TOOLCALL/PIPELINE/DIALOGUE/BRAINSTORM/
// SYNTHESIS/CLASSIFY/COT 共 9 个模板文件不可达（死资产）。现补：
//   1. TEMPLATE_ROUTE 增加推理类任务（数学/逻辑/调试 → COT，TASK_NEEDS_REASONING 早已含这些）
//   2. SUB_ROUTE 支持任务子类（fp.subtype）精确路由 → 20 个模板全部可达
const TEMPLATE_ROUTE = {
  代码: "RISEN",
  写作: "COSTAR",
  分析: "COSTAR",
  抽取: "SCHEMA",
  分类: "FEWSHOT",
  创意: "CRISPE",
  对话: "RTF",
  agentic: "REACT",
  RAG: "RAG",
  图像: "VISION",
  教育: "SOCRATIC",
  决策: "DECISION",
  // 推理类任务（数学/逻辑/调试）此前无路由 → 统一走 COT
  数学: "COT",
  逻辑: "COT",
  调试: "COT",
};
// 子类路由（fp.subtype）：任务子类 → 更精确模板（未命中回退 TEMPLATE_ROUTE）
const SUB_ROUTE = {
  代码:   { 推理: "COT", 调试: "COT", 常驻: "AGENT", 工具调用: "TOOLCALL" },
  agentic: { 工具调用: "TOOLCALL", mcp: "MCP", 管道: "PIPELINE", 常驻: "AGENT" },
  对话:   { 多轮: "DIALOGUE", 客服: "DIALOGUE", 快速单步: "RTF" },
  创意:   { 头脑风暴: "BRAINSTORM", 发散: "BRAINSTORM" },
  分析:   { 多源综合: "SYNTHESIS", 综合: "SYNTHESIS" },
  分类:   { 有限类别: "CLASSIFY", 稳定分类: "CLASSIFY" },
  写作:   { 品牌: "CRISPE", 个性化: "CRISPE" },
};
const FALLBACK_TEMPLATE = "COSTAR";

// 路由解析：subtype 优先 → task_type → fallback（记录来源供审计）
function routeTemplate(fp) {
  const sub = fp.subtype ? SUB_ROUTE[fp.task_type]?.[fp.subtype] : null;
  if (sub) return { template: sub, via: "subtype", subtype: fp.subtype };
  const t = TEMPLATE_ROUTE[fp.task_type];
  if (t) return { template: t, via: "task" };
  return { template: FALLBACK_TEMPLATE, via: "fallback" };
}

const TASK_NEEDS_REASONING = new Set(["代码", "分析", "数学", "逻辑", "调试", "决策"]);
const TASK_NEEDS_GROUNDING = new Set(["RAG", "分析", "抽取", "教育"]); // 防幻觉锚点
const TASK_NEEDS_FEWSHOT = new Set(["抽取", "分类"]);

// ================= 模型族方言配置（与 references/environment-matrix.md §2 对齐） =================
const MODEL_STYLE = {
  claude:   { syntax: "xml",   cot: true,  system_follow: "high",   hint: "Claude：使用 XML 标签包裹结构段落" },
  gpt:      { syntax: "md",    cot: true,  system_follow: "high",   hint: "GPT：使用 Markdown 标题组织结构" },
  gemini:   { syntax: "md",    cot: true,  system_follow: "high",   hint: "Gemini：清晰指令 + 结构化标题" },
  deepseek: { syntax: "plain", cot: true,  system_follow: "medium", hint: "DeepSeek：中文简洁指令，CoT 友好" },
  doubao:   { syntax: "plain", cot: true,  system_follow: "medium", hint: "豆包：中文简洁指令" },
  glm:      { syntax: "plain", cot: true,  system_follow: "medium", hint: "GLM：结构化中文指令" },
  qwen:     { syntax: "plain", cot: true,  system_follow: "medium", hint: "Qwen：中文简洁指令" },
  kimi:     { syntax: "plain", cot: true,  system_follow: "medium", hint: "Kimi：中文简洁指令" },
  open:     { syntax: "md",    cot: true,  system_follow: "low",    hint: "开源模型：保守结构，显式格式约束" },
};

// 模型族方言配置见上 MODEL_STYLE；平台形态×结构约束表见 references/environment-matrix.md §3
// （PLATFORM_REQUIREMENTS 已移除：定义后零引用，属死代码；其信息由文档承载）

// ================= 技术选择 =================
function selectTechniques(fp) {
  const techs = [];
  const reasons = [];
  const style = MODEL_STYLE[fp.model_family] || MODEL_STYLE.open;

  // 角色设定（总是）
  techs.push("角色设定");
  reasons.push("校准深度与措辞（可靠边界效应）");

  // 结构语法
  if (style.syntax === "xml") { techs.push("XML 结构标签"); reasons.push("Claude 族解析 XML 最可靠"); }
  else if (style.syntax === "md") { techs.push("Markdown 结构标题"); reasons.push("GPT/Gemini 族标题遵循度高"); }
  else { techs.push("中文简洁分段"); reasons.push("国产模型族长提示词易丢失，用精简分段"); }

  // CoT（推理任务且非 o 系）
  const isOSeries = /^o\d/i.test(fp.model_version || "");
  if (TASK_NEEDS_REASONING.has(fp.task_type) && style.cot && !isOSeries) {
    techs.push("Chain-of-Thought");
    reasons.push(`${fp.task_type} 任务需推理链路${isOSeries ? "" : ""}`);
  }
  if (isOSeries) {
    techs.push("禁用显式 CoT");
    reasons.push("o 系模型自带推理，显式 CoT 指令反而干扰");
  }

  // 防幻觉锚点
  if (TASK_NEEDS_GROUNDING.has(fp.task_type)) {
    techs.push("防幻觉锚点");
    reasons.push(`${fp.task_type} 任务涉及事实，需"无法回答/注明来源"兜底`);
  }

  // Few-shot
  if (TASK_NEEDS_FEWSHOT.has(fp.task_type) && (fp.context_budget == null || fp.context_budget >= 800)) {
    techs.push("Few-shot 示例");
    reasons.push(`${fp.task_type} 需格式一致性，示例比指令可靠`);
  }

  // 隔离标注（含外部输入或 RAG）
  if (fp.platform_form === "rag" || fp.task_type === "RAG" || fp.request?.includes("<input>") || fp.need_input_isolation) {
    techs.push("隔离标注");
    reasons.push("外部输入必须分隔标识，防间接注入（OWASP 建议 6）");
  }

  // 记忆块（对话/长会话）
  if (fp.platform_form === "chat" && fp.user_level === "novice") {
    techs.push("记忆块提示");
    reasons.push("长会话防自相矛盾（Prompt Master 实测最大改进）");
  }

  return { techs, reasons };
}

// ================= 组装 =================
function assemblePrompt(fp, template, style, techs) {
  const req = (fp.request || "").trim();
  const lines = [];
  const wrap = (tag, content) => (style.syntax === "xml" ? `<${tag}>\n${content}\n</${tag}>` : content);

  // 1. 角色（模板差异）
  const roleLine = fp.role || "专业助手";
  lines.push(wrap("role", `你是一个${roleLine}。`));

  // 2. 任务
  const taskLine = req || `{此处填写任务目标}（请按模板结构补充细节）`;
  lines.push("");
  lines.push(wrap("task", `任务：${taskLine}`));

  // 3. 模板特有结构
  const section = (title, body) => lines.push("", style.syntax === "md" ? `## ${title}` : `【${title}】`, body);
  switch (template) {
    case "RISEN":
      section("步骤 Steps", "按以下顺序执行：\n1. {步骤1}\n2. {步骤2}\n3. {步骤3}");
      section("终点 End Goal", "完成标准（可验证）：\n- {可验证条件1}\n- {可验证条件2}");
      section("收窄 Narrowing", "只做{范围限定}；不做{明确排除事项}。");
      break;
    case "COSTAR":
      section("背景 Context", "{任务背景：为什么做、相关材料}（如无背景可写「无需额外背景」）");
      section("风格与语气 Style/Tone", "风格：{正式/轻松/科技}；语气：{客观/鼓励}。");
      section("受众 Audience", "受众：{目标读者与专业程度}。");
      break;
    case "SCHEMA":
      section("输出 Schema", "输出 JSON，字段：{字段1:类型, 字段2:类型}。\n- 字段缺失时值为 null，不要编造\n- 只输出 JSON，不额外解释");
      if (techs.includes("Few-shot 示例")) section("示例 Examples", "{示例 JSON 1 条}");
      break;
    case "FEWSHOT":
      section("类别白名单（分类时）", "- {类别1}\n- {类别2}\n无法归类时输出：{兜底类别}");
      section("示例 Examples", "输入1：{示例}\n输出1：{示例}\n输入2：{示例}\n输出2：{示例}");
      break;
    case "REACT":
      section("可用工具", "- {工具1}: {用途}\n- {工具2}: {用途}");
      section("工作循环", "思考 → 行动 → 观察 → 重复，直到满足停止条件。");
      section("停止条件", "- {完成标准}达成时停止并输出\n- 连续失败 {N} 次时停止并报告\n- 无法确定时询问用户，不擅自猜测");
      section("权限边界", "只允许：{白名单}；禁止：{黑名单}。");
      break;
    case "RAG":
      section("上下文", "<context>\n{检索内容，分段标注}\n</context>\n回答必须标注引用来源段编号 [段号]。");
      section("兜底规则", "- 上下文不足以回答时，回复「无法从提供内容中回答」，不要编造\n- 上下文矛盾时指出矛盾，不自行取舍");
      break;
    case "VISION":
      section("视觉描述", "{主体}，{动作}，{环境}，{光线}，{构图}，{风格}，{画质}，{画幅}（如 SD/ComfyUI 附负向提示词）");
      break;
    case "SOCRATIC":
      section("引导规则", "用提问引导学习者自行发现答案：先问前置概念；答错时用提示性问题纠正；最后综合问题巩固。");
      break;
    case "DECISION":
      section("决策框架", "候选方案：{A/B/C}；评估维度与权重：{成本/收益/风险}；输出每方案打分+加权总分+推荐+理由。");
      break;
    case "COT":
      section("逐步推理", "请按以下步骤逐步推理，并在每一步说明依据：\n1. 理解问题：{重述问题，确认理解无误}\n2. 拆解：{分解为可独立求解的子问题}\n3. 求解：{逐步求解，每步标注依据}\n4. 验证：{检查结果是否合理，是否有遗漏边界}");
      section("结论", "最后给出结论（单独成段，便于解析）：\n结论：{最终答案}");
      break;
    case "DIALOGUE":
      section("身份与边界", "身份：{角色定位}；语气：{语气}；语言：{中/英/双语}。\n边界：{禁忌话题清单}；越界时回复：{拒绝话术}。");
      section("回复规则", "每轮长度：{一句话/≤50字}；信息不足时主动追问澄清，不猜测；长会话用记忆块保持已确认偏好一致。");
      break;
    case "AGENT":
      section("能力边界", "能做：{能力白名单}；不能做：{明确排除项}——越界时回复：{拒绝话术}。");
      section("行为规则", "任务开始前：{先读上下文/先确认需求}；执行中：{小步提交/每步汇报}；完成时：{自检/输出总结}。");
      section("失败策略", "遇到错误：{重试 1 次 → 仍失败则报告，不猜测}；工具调用失败：{记录原因，换方案或停止}；不确定时：{询问用户}。");
      break;
    case "MCP":
      section("工具描述", "工具名：{name}\n描述：{一句话用途，含触发信号——决定宿主何时调用}\n参数（JSON schema）：{type/properties/required}。");
      section("返回与错误", "返回：{成功/失败/错误格式}；错误处理：{失败时返回的错误码/信息约定}。");
      break;
    case "TOOLCALL":
      section("可用函数", "- {函数名}(参数1: 类型, 参数2: 类型): {用途}\n- {函数名2}(参数1: 类型): {用途}");
      section("调用规则", "参数缺失时：{询问用户，不猜测默认值}；参数校验：{类型/范围约束}；返回错误时：{重试 1 次 → 仍失败则报告，不静默重试}。");
      break;
    case "PIPELINE":
      section("处理阶段", "1. {输入清洗}：{规则}\n2. {主处理}：{规则}\n3. {输出校验}：{规则}\n每阶段输入输出：{格式定义}。");
      section("错误处理", "单条失败：{跳过并记录/重试 1 次/停止}；批量失败率超 {X}%：{停止并报告}；校验失败：{修复 or 标记}。");
      break;
    case "BRAINSTORM":
      section("发散要求", "至少 {N} 个方案（N≥5）；从 {用户视角/技术视角/反常识/借鉴其他领域} 各出 {X} 个。");
      section("可行域", "约束：{成本/时间/技术/合规限制}；排除：{明确不要的方向}。\n输出：每方案 名称+一句话价值+一句风险；最后标注 Top 3 推荐及理由。");
      break;
    case "SYNTHESIS":
      section("综合要求", "合并多源观点；观点矛盾时指出矛盾点不自行取舍（如必须取舍说明依据）；结论必须引用材料编号 [1]/[2]/[3]；材料未覆盖的方面标注「材料未覆盖」，不编造。");
      section("输出格式", "议题 1：{综合结论}（依据 [1][2]）…\n缺口清单：{未覆盖项}。");
      break;
    case "CLASSIFY":
      section("类别白名单", "- {类别1}：{定义/判定标准}\n- {类别2}：{定义/判定标准}\n- {兜底类别}：{无法归入以上类别时}");
      section("判断规则", "多类别冲突时取{优先级/主意图}；无法自信分类时输出：{兜底类别}（不要发明新类别）。");
      section("示例", "输入1：{示例} → 输出1：{类别}\n输入2：{示例} → 输出2：{类别}");
      break;
    case "RTF":
    case "CRISPE":
    default:
      break; // 通用骨架足够
  }

  // 4. 输出格式约束（Specificity 底线）
  lines.push("");
  const fmtParts = [];
  if (fp.output_format) fmtParts.push(`格式：${fp.output_format}`);
  if (fp.max_length) fmtParts.push(`长度：不超过 ${fp.max_length}`);
  if (fmtParts.length) lines.push(wrap("format", fmtParts.join("；")));
  else if (style.syntax === "md") lines.push("## 输出格式", "{格式/长度/要素约束}");
  else lines.push("【输出格式】{格式/长度/要素约束}");

  // 5. 防幻觉锚点
  if (techs.includes("防幻觉锚点")) {
    lines.push("");
    lines.push(wrap("grounding", "不要编造信息；无法确定时明确说明；涉及事实/引用时注明来源。"));
  }

  // 6. 兜底/边界（Robustness）
  lines.push("");
  lines.push(wrap("boundary", "如遇边界情况（输入缺失/无法处理），按「{兜底行为}」处理，不要猜测。"));

  return lines.join("\n");
}

// ================= 情报检索建议（关键节点才搜, §3.4） =================
function searchSuggestions(fp) {
  const s = [];
  const v = fp.model_version || "";
  // 1. 较新模型族/显式版本 → 核实能力
  if (fp.model_family === "open" || v) {
    s.push({ node: "L2 环境指纹", query: `${fp.model_family} ${v || ""} 最新 prompt 能力（CoT/长上下文/遵循度）`, reason: "模型更新快，静态矩阵可能过时" });
  }
  // 2. 图像 → 核实最新工具语法
  if (fp.task_type === "图像") {
    s.push({ node: "L3 选型", query: "当前 Midjourney/DALL-E/SD 最新提示词语法变化", reason: "图像工具语法迭代快" });
  }
  // 3. RAG → 引用格式最佳实践
  if (fp.task_type === "RAG") {
    s.push({ node: "L3 选型", query: "RAG 引用格式与防幻觉最新实践 2026", reason: "检索场景防幻觉方法演进快" });
  }
  // 4. 迁移场景
  if (fp.from_model && fp.from_model !== fp.model_family) {
    s.push({ node: "迁移", query: `${fp.from_model} → ${fp.model_family} 提示词迁移差异`, reason: "跨模型族方言差异需核实" });
  }
  return s;
}

// ================= 主入口 =================
export function buildPrompt(fp) {
  if (!fp || typeof fp !== "object") throw new Error("指纹必须为对象");
  if (!fp.model_family) throw new Error("缺少 model_family（模型族）");
  if (!fp.task_type) throw new Error("缺少 task_type（任务类型）");
  if (!fp.platform_form) throw new Error("缺少 platform_form（平台形态）");

  const style = MODEL_STYLE[fp.model_family] || MODEL_STYLE.open;
  const { template, via, subtype } = routeTemplate(fp);
  const { techs, reasons } = selectTechniques(fp);
  const prompt = assemblePrompt(fp, template, style, techs);
  const search = searchSuggestions(fp);

  // Fit 检查（环境适配）
  const fitMissing = [];
  if (!fp.request) fitMissing.push("request（任务需求）");
  if (fp.context_budget == null) fitMissing.push("context_budget（上下文预算）");
  if (!fp.user_level) fitMissing.push("user_level（用户水平）");
  if (!fp.language) fitMissing.push("language（语言）");

  return {
    meta: {
      engine: "build-prompt.mjs v1.0.0",
      template,
      template_fallback: !TEMPLATE_ROUTE[fp.task_type] && !subtype,
      route_via: via,
      model_family: fp.model_family,
      platform_form: fp.platform_form,
      task_type: fp.task_type,
      subtype: subtype || null,
    },
    prompt,
    routing: {
      template,
      reason: via === "subtype"
        ? `任务 ${fp.task_type} + 子类 ${subtype} → 模板 ${template}`
        : via === "task"
          ? `任务类型 ${fp.task_type} → 推荐模板 ${template}`
          : `任务类型 ${fp.task_type} 未映射，回退通用模板 ${template}（已记录 usage log）`,
    },
    techniques: techs,
    technique_reasons: reasons,
    search_suggestions: search,
    fit: {
      complete: fitMissing.length === 0,
      missing: fitMissing,
    },
    template_ref: `assets/templates/${template}.md`,
  };
}

// CLI 入口
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith("--") && !a.startsWith("{") && !a.startsWith("[") && !/^-?\d+$/.test(a));
  const wantJson = args.includes("--json");
  let input;
  if (fileArg) {
    input = readFileSync(fileArg, "utf8");
  } else {
    input = readFileSync(0, "utf8");
  }
  const fp = JSON.parse(input);
  const result = buildPrompt(fp);
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log(`=== 构建结果 [${result.meta.template}] 模型=${fp.model_family} 平台=${fp.platform_form} 任务=${fp.task_type} ===`);
    console.log("路由:", result.routing.reason);
    console.log("技术栈:", result.techniques.join(" + "));
    console.log("Fit:", result.fit.complete ? "完整" : `缺 ${result.fit.missing.join("、")}`);
    console.log("情报检索建议:", result.search_suggestions.length ? result.search_suggestions.map((s) => `[${s.node}] ${s.query}`).join(" | ") : "无");
    console.log("");
    console.log("---- 提示词 ----");
    console.log(result.prompt);
  }
}
