#!/usr/bin/env node
// matrix-check.mjs — 三层矩阵一致性校验（防"文档与代码漂移"）
// 校验四方一致性:
//   1. build-prompt.mjs 的 TEMPLATE_ROUTE（任务→模板）与 MODEL_STYLE（模型族）
//   2. references/environment-matrix.md 文档（任务映射表 + 模型族表）
//   3. sem-score.mjs 的 TASK_SIGNALS（模板信号表）与 DIALECT_SIGNALS（模型族方言）
//   4. templates/ 目录文件（模板骨架是否存在）
// 用途: 文档、构建引擎、评分引擎三处若不同步，会出现"构建出 A 模板但评分用 B 信号"的隐性 bug
// 用法:
//   node scripts/matrix-check.mjs
//   node scripts/matrix-check.mjs --json
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============ 提取各源头的矩阵 ============

// 提取对象顶层键（匹配缩进 2 空格的顶层条目，避免嵌套字段误报）
function topKeys(block) {
  const keys = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s{2}([^\s:,{}]+):\s*["'{[]/);
    if (m) keys.push(m[1].replace(/['"]/g, ""));
  }
  return keys;
}

// 从 build-prompt.mjs 提取 TEMPLATE_ROUTE 与 MODEL_STYLE 的顶层键，以及 SUB_ROUTE 的全部路由值
function extractBuildMatrix() {
  const src = readFileSync(join(ROOT, "scripts", "build-prompt.mjs"), "utf8");
  const routeBlock = src.match(/const TEMPLATE_ROUTE = \{([\s\S]*?)\n\};/);
  const styleBlock = src.match(/const MODEL_STYLE = \{([\s\S]*?)\n\};/);
  const subRouteBlock = src.match(/const SUB_ROUTE = \{([\s\S]*?)\n\};/);
  return {
    routes: routeBlock ? topKeys(routeBlock[1]) : [],
    styles: styleBlock ? topKeys(styleBlock[1]) : [],
    subRouteValues: subRouteBlock ? extractTemplateValues(subRouteBlock[1]) : [],
  };
}

// 提取 SUB_ROUTE 块中的全部模板值（如 "COT"/"MCP"/"AGENT"…，去重）
function extractTemplateValues(block) {
  const values = [];
  for (const m of block.matchAll(/:\s*"([A-Z]+)"/g)) {
    if (!values.includes(m[1])) values.push(m[1]);
  }
  return values;
}

// 从 environment-matrix.md 提取任务名与模型族
function extractDocMatrix() {
  const doc = readFileSync(join(ROOT, "references", "environment-matrix.md"), "utf8");
  const tasks = [];
  const taskSection = doc.match(/\|\s*(代码|写作|分析|抽取|分类|创意|对话|agentic|RAG|图像|教育|决策)\s*\|\s*([A-Z]+)/g) || [];
  for (const m of taskSection) {
    const t = m.match(/\|\s*([^|]+?)\s*\|/);
    if (t) tasks.push(t[1].trim());
  }
  const models = [];
  const modelHeader = doc.match(/^\|\s*维度\s*\|([^\n]*)\|/m);
  if (modelHeader) {
    for (const m of modelHeader[1].matchAll(/(Claude|GPT|Gemini|DeepSeek|豆包|GLM|Qwen|Kimi|开源)/g)) {
      models.push(m[1]);
    }
  }
  return { tasks: [...new Set(tasks)], models: [...new Set(models)] };
}

// 从 sem-score.mjs 提取 TASK_SIGNALS 与 DIALECT_SIGNALS 的顶层键
function extractSemMatrix() {
  const src = readFileSync(join(ROOT, "scripts", "sem-score.mjs"), "utf8");
  const taskBlock = src.match(/const TASK_SIGNALS = \{([\s\S]*?)\n\};/);
  const dialectBlock = src.match(/const DIALECT_SIGNALS = \{([\s\S]*?)\n\};/);
  return {
    signals: taskBlock ? topKeys(taskBlock[1]) : [],
    dialects: dialectBlock ? topKeys(dialectBlock[1]) : [],
  };
}

// templates/ 目录文件（去掉 .md 后缀，转大写）
function listTemplateFiles() {
  const dir = join(ROOT, "assets", "templates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "").toUpperCase());
}

// ============ 主校验 ============
export function checkMatrix() {
  const build = extractBuildMatrix();
  const doc = extractDocMatrix();
  const sem = extractSemMatrix();
  const files = listTemplateFiles();

  const issues = [];
  const notes = [];

  // 1. 模型族：build.styles ↔ doc.models ↔ sem.dialects
  const styleSet = new Set(build.styles);
  const docModelSet = new Set(doc.models.map(normalizeModel));
  const dialectSet = new Set(sem.dialects);
  const allModels = new Set([...build.styles, ...doc.models, ...sem.dialects]);
  for (const m of allModels) {
    const norm = normalizeModel(m);
    if (!styleSet.has(norm)) issues.push(`模型族 "${m}" 在 build-prompt.mjs MODEL_STYLE 中缺失`);
    if (!docModelSet.has(norm)) issues.push(`模型族 "${m}" 在 environment-matrix.md 文档中缺失`);
    if (!dialectSet.has(norm)) issues.push(`模型族 "${m}" 在 sem-score.mjs DIALECT_SIGNALS 中缺失`);
  }

  // 2. 任务→模板：build.routes ↔ doc.tasks ↔ templates 文件
  const routeSet = new Set(build.routes);
  for (const t of doc.tasks) {
    if (!routeSet.has(t)) issues.push(`任务 "${t}" 在 build-prompt.mjs TEMPLATE_ROUTE 中缺失`);
  }
  // 模板信号表 vs 模板文件
  const signalSet = new Set(sem.signals);
  for (const f of files) {
    if (!signalSet.has(f)) issues.push(`模板文件 ${f}.md 缺少 sem-score.mjs TASK_SIGNALS 信号表`);
  }
  for (const s of sem.signals) {
    if (!files.includes(s)) issues.push(`sem-score.mjs 信号表 "${s}" 无对应 assets/templates/${s}.md 文件`);
  }

  const routeValues = build.routes.map((k) => ({ key: k, val: extractRouteValue(k) })).filter((x) => x.val);
  for (const { key, val } of routeValues) {
    if (!files.includes(val)) issues.push(`任务 "${key}" 路由到模板 ${val}，但无 assets/templates/${val}.md 文件`);
  }

  // 3. 路由可达性（P1-2 补全）：每个模板文件必须被主路由或子类路由引用，否则是死资产
  //    （此前 AGENT/MCP/TOOLCALL/PIPELINE/DIALOGUE/BRAINSTORM/SYNTHESIS/CLASSIFY 不可达）
  const reachable = new Set([...routeValues.map((x) => x.val), ...(build.subRouteValues || [])]);
  for (const f of files) {
    if (!reachable.has(f)) {
      issues.push(`模板 ${f}.md 不可达：TEMPLATE_ROUTE 与 SUB_ROUTE 均未引用（死资产，需补路由或删除）`);
    }
  }

  return {
    summary: {
      models: [...allModels].length,
      tasks: build.routes.length,
      templates: files.length,
      signals: sem.signals.length,
    },
    details: { build, doc, sem, files },
    issues,
    notes: [...notes, "矩阵来源：build-prompt.mjs(构建) / environment-matrix.md(文档) / sem-score.mjs(评分) / assets/templates/(骨架)"],
    ok: issues.length === 0,
  };
}

function normalizeModel(m) {
  const map = { Claude: "claude", GPT: "gpt", Gemini: "gemini", DeepSeek: "deepseek", 豆包: "doubao", GLM: "glm", Qwen: "qwen", Kimi: "kimi", 开源: "open" };
  return map[m] || m.toLowerCase();
}

function extractRouteValue(task) {
  const src = readFileSync(join(ROOT, "scripts", "build-prompt.mjs"), "utf8");
  const m = src.match(new RegExp(task + `:\\s*"([A-Z]+)"`));
  return m ? m[1] : null;
}

// ============ CLI ============
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const wantJson = process.argv.includes("--json");
  const r = checkMatrix();
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log("=== 矩阵一致性校验 ===");
    console.log(`模型族 ${r.summary.models} 个 / 任务 ${r.summary.tasks} 个 / 模板 ${r.summary.templates} 个 / 信号 ${r.summary.signals} 个`);
    if (r.issues.length) {
      console.log(`❌ 发现 ${r.issues.length} 处不一致:`);
      for (const i of r.issues) console.log(`  - ${i}`);
    } else {
      console.log("✅ 四方矩阵完全一致（构建/文档/评分/模板无漂移）");
    }
  }
  process.exit(r.ok ? 0 : 1);
}
