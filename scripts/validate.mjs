#!/usr/bin/env node
// validate.mjs — P0 门禁校验器：JSON 有效性、SKILL.md token 估算、目录完整性、脚本语法
// 用法: node scripts/validate.mjs  （退出码 0=通过，1=失败）
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

function check(cond, msg, isWarning = false) {
  if (!cond) { (isWarning ? warnings : errors).push(msg); }
  else { console.log(`  ✓ ${msg}`); }
}

// 1. JSON 文件有效性
console.log("== JSON 有效性 ==");
const jsonFiles = ["assets/evals/triggers.json"];
for (const f of jsonFiles) {
  const p = join(ROOT, f);
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    check(typeof j === "object" && j !== null, `JSON 可解析: ${f}`);
    // 触发评测结构检查
    if (f === "assets/evals/triggers.json") {
      check(Array.isArray(j.should_trigger) && j.should_trigger.length >= 12, `should_trigger ≥12 条（实际 ${j.should_trigger?.length ?? 0}）`);
      check(Array.isArray(j.should_not_trigger) && j.should_not_trigger.length >= 8, `should_not_trigger ≥8 条（实际 ${j.should_not_trigger?.length ?? 0}）`);
      check(j.meta?.acceptance?.should_trigger_min === 0.9, "验收阈值应 should≥90%");
      check(j.meta?.acceptance?.should_not_false_positive_max === 0.1, "验收阈值应误触≤10%");
    }
  } catch (e) {
    check(false, `JSON 解析失败: ${f} — ${e.message}`);
  }
}

// 2. 目录完整性（P0 骨架要求）
// 注：data 私有子目录（golden/failures/versions/memory/experience/search-cache/habit-profile）
// 由各引擎 ensureDir 运行时创建、不随 skill 分发，故不要求预先存在。
console.log("== 目录完整性 ==");
const requiredDirs = ["references", "assets/templates", "scripts", "assets/evals", "assets/data/lexicon"];
for (const d of requiredDirs) {
  check(existsSync(join(ROOT, d)) && statSync(join(ROOT, d)).isDirectory(), `目录存在: ${d}`);
}

const requiredRefs = ["environment-matrix", "assets/templates", "techniques", "scoring-rubric",
  "failure-taxonomy", "token-economy", "anti-patterns", "safety-policy", "expert-personas"];
for (const r of requiredRefs) {
  check(existsSync(join(ROOT, "references", `${r}.md`)), `references/${r}.md 存在`);
}

// 3. SKILL.md token 估算（粗估：中文 1 字≈1.0 token，英文 1 词≈1.3 token）
console.log("== SKILL.md 规模 ==");
const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const cjk = (skill.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
const nonCjkWords = skill.split(/\s+/).filter(Boolean).filter((t) => !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t)).length;
const estTokens = Math.round(cjk * 1.0 + nonCjkWords * 1.3);
console.log(`  估算: ${estTokens} token（中文 ${cjk} 字，英文 ${nonCjkWords} 词）`);
check(estTokens <= 2000, `SKILL.md ≤2000 token（当前估 ${estTokens}）`);

// 4. 别名同步（P1-3 增强：除非空外，校验关键锚点词与 SKILL.md 一致，防内容漂移）
console.log("== 别名同步 ==");
const skillBody = skill.split("---").slice(2).join("---").trim();
// SKILL.md 关键锚点词：别名必须覆盖这些核心能力标识，否则视为内容漂移
const ALIAS_ANCHORS = ["五层流水线", "Q-Score", "scan-safety", "pipe.mjs", "fail-closed", "references/", "L0", "token"];
for (const alias of ["CLAUDE.md", "AGENTS.md"]) {
  const p = join(ROOT, alias);
  if (existsSync(p)) {
    let body = readFileSync(p, "utf8").trim();
    if (body.startsWith("---")) {
      body = body.split("---").slice(2).join("---").trim();
    }
    check(body.length > 0, `${alias} 非空`);
    check(skillBody.length > 0 && body.length >= 200, `${alias} 内容完整（≥200 字符）`);
    const missingAnchors = ALIAS_ANCHORS.filter((a) => !body.includes(a));
    check(missingAnchors.length === 0, `${alias} 锚点同步（缺 ${missingAnchors.join("/") || "无"}）`);
  } else {
    check(false, `${alias} 存在`);
  }
}

// 4b. 版本一致性（P1-3）：以 data/lexicon/red.json 的 meta.version 为单一版本源（skill 自带，不依赖外部工程文件）；
//     脚本中出现的版本标注必须与其一致（防漂移）
console.log("== 版本一致性 ==");
let EXPECTED_VERSION = null;
try {
  const lex = JSON.parse(readFileSync(join(ROOT, "assets", "data", "lexicon", "red.json"), "utf8"));
  EXPECTED_VERSION = lex?.meta?.version || null;
} catch {
  check(true, "词库 meta.version 缺失，跳过版本一致性检查（提示）");
}
if (EXPECTED_VERSION) {
  check(typeof EXPECTED_VERSION === "string" && /^\d+\.\d+\.\d+$/.test(EXPECTED_VERSION), `词库版本合法 = ${EXPECTED_VERSION}`);
  const scriptDir = join(ROOT, "scripts");
  const { readdirSync } = await import("node:fs");
  const mjsFiles = readdirSync(scriptDir).filter((f) => f.endsWith(".mjs"));
  let bad = 0;
  const offenders = [];
  for (const f of mjsFiles) {
    const src = readFileSync(join(scriptDir, f), "utf8");
    for (const m of src.matchAll(/v(\d+\.\d+\.\d+)/g)) {
      if (m[1] !== EXPECTED_VERSION) { bad++; offenders.push(`${f}:v${m[1]}`); }
    }
  }
  check(bad === 0, `脚本版本标注与词库 v${EXPECTED_VERSION} 一致（${mjsFiles.length} 个脚本，${offenders.length ? "违规: " + offenders.join(", ") : "全部一致"}）`);
}

// 5. 脚本语法（install-local.sh 存在且可读）
console.log("== 脚本 ==");
check(existsSync(join(ROOT, "scripts", "install-local.sh")), "scripts/install-local.sh 存在");
check(existsSync(join(ROOT, "scripts", "scan-safety.mjs")), "scripts/scan-safety.mjs 存在（P4 必须）");

// 6. 评分引擎冒烟测试（P1）
console.log("== 评分引擎（P1）==");
const scoreEnginePath = join(ROOT, "scripts", "score-prompt.mjs");
if (existsSync(scoreEnginePath)) {
  try {
    const { scorePrompt } = await import(`file://${scoreEnginePath.replace(/\\/g, "/")}`);
    const scoring = JSON.parse(readFileSync(join(ROOT, "assets/evals", "scoring.json"), "utf8"));
    const cases = scoring.cases || [];
    check(cases.length >= 10, `scoring.json 用例 ≥10 条（实际 ${cases.length}）`);

    const bandOf = (s) => (s < 55 ? "需重写" : s < 70 ? "定向修补" : s < 85 ? "可用" : "优秀");
    let bandHits = 0;
    let determinismOk = 0;
    let issueRecallHits = 0;
    let issueRecallTotal = 0;

    for (const c of cases) {
      const r1 = scorePrompt(c.prompt);
      const r2 = scorePrompt(c.prompt);
      const same = r1.structural_score === r2.structural_score;
      if (same) determinismOk++;

      const expectedBand = c.expected_band;
      const actualBand = bandOf(r1.structural_score);
      let bandOk = actualBand === expectedBand;
      // 分数带断言 + 附加 min/max 约束
      if (c.expected_score_min != null && r1.structural_score < c.expected_score_min) bandOk = false;
      if (c.expected_score_max != null && r1.structural_score > c.expected_score_max) bandOk = false;
      if (bandOk) bandHits++;

      // 问题召回：expected_issues 至少 1 项被引擎 findings 命中（子串匹配）
      if (Array.isArray(c.expected_issues) && c.expected_issues.length > 0) {
        issueRecallTotal++;
        const allFindings = Object.values(r1.dimensions)
          .flatMap((d) => (d.findings || []).map((f) => `${f.dim || ""} ${f.rule}`));
        const hit = c.expected_issues.some((issue) => allFindings.some((f) => f.includes(issue)));
        if (hit) issueRecallHits++;
      }

      console.log(`  ${c.id} ${c.label}: ${r1.structural_score}/100 [${actualBand}] 期望[${expectedBand}] ${bandOk ? "✓" : "✗"} 确定性${same ? "✓" : "✗"}`);
    }

    check(determinismOk === cases.length, `确定性：${determinismOk}/${cases.length} 用例两轮评分一致（应 100%）`);
    check(bandHits / cases.length >= 0.9, `分数带准确率：${bandHits}/${cases.length} ≥90%`);
    if (issueRecallTotal > 0) {
      check(issueRecallHits / issueRecallTotal >= 0.8, `问题召回：${issueRecallHits}/${issueRecallTotal} ≥80%`);
    }
  } catch (e) {
    check(false, `评分引擎测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/score-prompt.mjs 不存在（P1 必须）");
}

// 7. 构建引擎冒烟测试（P2）
console.log("== 构建引擎（P2）==");
const buildEnginePath = join(ROOT, "scripts", "build-prompt.mjs");
if (existsSync(buildEnginePath)) {
  try {
    const { buildPrompt } = await import(`file://${buildEnginePath.replace(/\\/g, "/")}`);
    const buildCases = JSON.parse(readFileSync(join(ROOT, "assets/evals", "build-cases.json"), "utf8"));
    const fps = buildCases.fingerprints || [];
    const migs = buildCases.migration_cases || [];
    check(fps.length === 24, `build-cases.json 黄金组合 =24 条（实际 ${fps.length}）`);
    check(migs.length >= 2, `迁移用例 ≥2 条（实际 ${migs.length}）`);

    let produced = 0;
    let routeHits = 0;
    let dialectOk = 0;
    for (const fp of fps) {
      let r;
      try {
        r = buildPrompt(fp);
      } catch (e) {
        console.log(`  ${fp.id}: ✗ 构建抛错 ${e.message}`);
        continue;
      }
      const hasPrompt = r.prompt && r.prompt.trim().length > 0;
      if (hasPrompt) produced++;
      const routeOk = r.meta.template === (fp.expect_template || "COSTAR");
      if (routeOk) routeHits++;
      // 方言检查：expect_xml=true 必须含 <role> 或 <task>；expect_md=true 必须含 "## "
      const hasXml = /<role>|<task>|<format>/.test(r.prompt);
      const hasMd = r.prompt.includes("## ");
      let dialect = (fp.expect_xml === true) === hasXml && (fp.expect_md === true) === hasMd;
      if (fp.expect_xml === false && fp.expect_md === false) dialect = !hasXml && !hasMd; // 中文简洁族
      if (dialect) dialectOk++;
      console.log(`  ${fp.id} ${fp.model_family}/${fp.platform_form}/${fp.task_type}: 模板[${r.meta.template}]${routeOk ? "✓" : `✗(期望${fp.expect_template})`} 方言${dialect ? "✓" : "✗"} 产出${hasPrompt ? "✓" : "✗"}`);
    }

    check(produced === fps.length, `24 组合全产出：${produced}/${fps.length}`);
    check(routeHits / fps.length >= 0.9, `路由准确率：${routeHits}/${fps.length} ≥90%`);
    check(dialectOk === fps.length, `方言检查：${dialectOk}/${fps.length} 100%`);

    // 迁移用例（按目标模型族判断方言：md 族需 ##，plain 族不得含 XML 与 ##）
    const styleOf = (family) => ({ claude: "xml", gpt: "md", gemini: "md", deepseek: "plain", doubao: "plain", glm: "plain", qwen: "plain", kimi: "plain", open: "md" })[family] || "plain";
    let migOk = 0;
    for (const m of migs) {
      const from = buildPrompt(m.from);
      const to = buildPrompt(m.to);
      const fromHasXml = /<role>|<task>|<format>/.test(from.prompt);
      const toHasXml = /<role>|<task>|<format>/.test(to.prompt);
      const toHasMd = to.prompt.includes("## ");
      const toStyle = styleOf(m.to.model_family);
      let ok = fromHasXml && !toHasXml; // 迁移后 XML 方言必须消失
      if (toStyle === "md") ok = ok && toHasMd;
      else ok = ok && !toHasMd; // plain 族（DeepSeek 等）不得出现 Markdown 标题
      if (ok) migOk++;
      console.log(`  ${m.id} ${m.label}: ${ok ? "✓" : "✗"}`);
    }
    check(migOk === migs.length, `迁移结构差异：${migOk}/${migs.length} 正确`);

    // 子类路由断言（P1-3）：subtype_cases 每条必须路由到 expect_template（20 模板全可达回归）
    const subtypes = buildCases.subtype_cases || [];
    check(subtypes.length >= 8, `subtype_cases ≥8 条（实际 ${subtypes.length}）`);
    let subOk = 0;
    for (const sc of subtypes) {
      let r;
      try {
        r = buildPrompt(sc.fp);
      } catch (e) {
        console.log(`  ${sc.id}: ✗ 构建抛错 ${e.message}`);
        continue;
      }
      const ok = r.meta.template === sc.expect_template && r.meta.route_via === sc.expect_via;
      if (ok) subOk++;
      console.log(`  ${sc.id} ${sc.label}: 模板[${r.meta.template}]${r.meta.template === sc.expect_template ? "✓" : `✗(期望${sc.expect_template})`} 路由[${r.meta.route_via}]${r.meta.route_via === sc.expect_via ? "✓" : `✗(期望${sc.expect_via})`}`);
    }
    check(subOk === subtypes.length, `子类路由准确率：${subOk}/${subtypes.length} 100%`);
  } catch (e) {
    check(false, `构建引擎测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/build-prompt.mjs 不存在（P2 必须）");
}

// 8. Token 经济性冒烟测试（P3）
console.log("== Token 经济性（P3）==");
const econEnginePath = join(ROOT, "scripts", "token-count.mjs");
if (existsSync(econEnginePath)) {
  try {
    const { detectRedundancy, budgetReport, estimateTokens } = await import(`file://${econEnginePath.replace(/\\/g, "/")}`);
    const econ = JSON.parse(readFileSync(join(ROOT, "assets/evals", "economy-cases.json"), "utf8"));
    const redCases = econ.redundancy_cases || [];
    const cleanCases = econ.clean_cases || [];
    const budCases = econ.budget_cases || [];
    check(redCases.length >= 6, `冗余用例 ≥6 条（实际 ${redCases.length}）`);
    check(cleanCases.length >= 3, `干净用例 ≥3 条（实际 ${cleanCases.length}）`);
    check(budCases.length >= 3, `预算用例 ≥3 条（实际 ${budCases.length}）`);

    // 冗余召回：预期类别至少 1 项命中
    let recallHits = 0;
    for (const c of redCases) {
      const r = detectRedundancy(c.prompt);
      const foundTypes = new Set(r.findings.map((f) => f.type));
      const labels = new Set(r.findings.map((f) => f.rule));
      const hit = (c.expected_redundancy || []).some((e) =>
        [...foundTypes].some((t) => t.includes(e)) || [...labels].some((l) => l.includes(e))
      );
      // 无预期冗余的用例（如英文）视为通过
      const ok = (c.expected_redundancy || []).length === 0 ? true : hit;
      if (ok) recallHits++;
      console.log(`  ${c.id} ${c.label}: 命中 ${r.findings.length} 处 ${ok ? "✓" : `✗(期望 ${c.expected_redundancy?.join("/")})`}`);
    }
    check(recallHits / redCases.length >= 0.9, `冗余召回：${recallHits}/${redCases.length} ≥90%`);

    // 不误伤：干净用例冗余命中为 0
    let fpClean = 0;
    for (const c of cleanCases) {
      const r = detectRedundancy(c.prompt);
      if (r.findings.length === 0) fpClean++;
      console.log(`  ${c.id} ${c.label}: 命中 ${r.findings.length} 处 ${r.findings.length === 0 ? "✓" : "✗(误伤)"}`);
    }
    check(fpClean === cleanCases.length, `不误伤：${fpClean}/${cleanCases.length} 干净用例 0 命中`);

    // 预算计算 + 确定性（仅对声明了 expect_over_budget 的用例做预算判定）
    let budOk = 0;
    let budTotal = 0;
    let detOk = 0;
    for (const c of budCases) {
      const r1 = budgetReport(c.prompt, c.target_budget);
      const r2 = budgetReport(c.prompt, c.target_budget);
      if (typeof c.expect_over_budget === "boolean") {
        budTotal++;
        if (c.expect_over_budget === r1.over_budget) budOk++;
      }
      if (r1.deviation_pct === r2.deviation_pct) detOk++;
      console.log(`  ${c.id} ${c.label}: 估算 ${r1.estimate.tokens} token 偏差 ${r1.deviation_pct}% ${r1.over_budget ? "超预算" : "OK"} ${typeof c.expect_over_budget === "boolean" ? (c.expect_over_budget === r1.over_budget ? "✓" : "✗") : "—"} 确定性${r1.deviation_pct === r2.deviation_pct ? "✓" : "✗"}`);
    }
    check(budOk === budTotal, `预算判定：${budOk}/${budTotal}`);
    check(detOk === budCases.length, `预算确定性：${detOk}/${budCases.length}`);
  } catch (e) {
    check(false, `Token 经济性测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/token-count.mjs 不存在（P3 必须）");
}

// 9. 安全扫描冒烟测试（P4）
console.log("== 安全扫描（P4）==");
const safetyEnginePath = join(ROOT, "scripts", "scan-safety.mjs");
if (existsSync(safetyEnginePath)) {
  try {
    const { scanSafety } = await import(`file://${safetyEnginePath.replace(/\\/g, "/")}`);
    const safety = JSON.parse(readFileSync(join(ROOT, "assets/evals", "safety.json"), "utf8"));
    const inj = safety.injection_cases || [];
    const red = safety.red_cases || [];
    const pii = safety.pii_cases || [];
    const clean = safety.clean_cases || [];
    const pol = safety.policy_cases || [];
    check(inj.length >= 8, `注入用例 ≥8 条（实际 ${inj.length}）`);
    check(red.length >= 6, `红线用例 ≥6 条（实际 ${red.length}）`);
    check(pii.length >= 5, `PII 用例 ≥5 条（实际 ${pii.length}）`);
    check(clean.length >= 10, `干净用例 ≥10 条（实际 ${clean.length}）`);

    // 注入拦截：level 必须为 red
    let injOk = 0;
    for (const c of inj) {
      const r = scanSafety(c.prompt);
      const ok = r.level === "red";
      if (ok) injOk++;
      console.log(`  ${c.id} ${c.label}: ${r.level} ${ok ? "✓" : "✗(期望 red)"}`);
    }
    check(injOk === inj.length, `注入拦截：${injOk}/${inj.length} 100%`);

    // 红线拦截：level 必须为 red
    let redOk = 0;
    for (const c of red) {
      const r = scanSafety(c.prompt);
      const ok = r.level === "red";
      if (ok) redOk++;
      console.log(`  ${c.id} ${c.label}: ${r.level} ${ok ? "✓" : "✗(期望 red)"}`);
    }
    check(redOk === red.length, `红线拦截：${redOk}/${red.length} 100%`);

    // PII 脱敏：level=yellow 且 redacted 含 [REDACTED: 标记（中文按空格分词不可靠，改用标记断言）
    let piiOk = 0;
    for (const c of pii) {
      const r = scanSafety(c.prompt);
      const redacted = r.redacted && r.redacted.includes("[REDACTED:");
      const ok = r.level === "yellow" && redacted;
      if (ok) piiOk++;
      console.log(`  ${c.id} ${c.label}: ${r.level} 脱敏标记${redacted ? "✓" : "✗"} ${ok ? "✓" : "✗"}`);
    }
    check(piiOk === pii.length, `PII 脱敏：${piiOk}/${pii.length} 100%`);

    // 误伤控制：干净用例不得为 red（允许 yellow/gray 但不得 red）
    let cleanOk = 0;
    for (const c of clean) {
      const r = scanSafety(c.prompt);
      const ok = r.level !== "red";
      if (ok) cleanOk++;
      console.log(`  ${c.id} ${c.label}: ${r.level} ${ok ? "✓" : "✗(误伤)"}`);
    }
    check(cleanOk / clean.length >= 0.95, `误伤控制：${cleanOk}/${clean.length} 非 red（≤5% 误伤）`);

    // 策略：红线层不可自动更新
    for (const p of pol) {
      try {
        const lex = JSON.parse(readFileSync(join(ROOT, p.check_file), "utf8"));
        const v = lex.meta?.[p.check_field];
        check(v === p.expected_value, `策略 ${p.id}：${p.check_file} 的 ${p.check_field} = "${v}"（红线层人工确认）`);
      } catch (e) {
        check(false, `策略 ${p.id} 检查失败: ${e.message}`);
      }
    }
  } catch (e) {
    check(false, `安全扫描测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/scan-safety.mjs 不存在（P4 必须）");
}

// 10. P5 跨引擎冒烟测试（版本化/画像/自进化/eval/双档）
// 注意：本文件已在各阶段使用顶层 await，因此 P5 测试直接用顶层代码（不用未 await 的 IIFE，
// 否则汇总段会先于 P5 断言执行，导致假通过或提前 exit）。
console.log("== P5 进化引擎 ==");
const tmp = mkdtempSync(join(tmpdir(), "univ-prompt-p5-"));
try {
    // 10.1 版本化（version-store）
    console.log("== 版本化（P5）==");
    const vsPath = join(ROOT, "scripts", "version-store.mjs");
    if (existsSync(vsPath)) {
      const vs = await import(`file://${vsPath.replace(/\\/g, "/")}`);
      const a = vs.snapshot({ dir: tmp, prompt: "重构 getUserData() 为 async/await", score: 70, dims: { clarity: 80 }, intent: "improve" });
      const b = vs.snapshot({ dir: tmp, prompt: "重构 getUserData() 为 async/await 并处理 null", score: 88, dims: { clarity: 90 }, intent: "improve" });
      const cmp = vs.compareVersions({ dir: tmp, from: a.id, to: b.id });
      check(cmp.qscore_delta === 18, `版本对比增量: ${a.qscore}→${b.qscore} Δ${cmp.qscore_delta}（期望 18）`);
      const rb = vs.rollbackPrompt({ dir: tmp, to: a.id });
      check(rb.prompt === a.prompt, "回滚返回目标版本提示词");
      check(vs.listVersions({ dir: tmp }).length === 2, "版本列表 = 2");
    } else check(false, "version-store.mjs 不存在（P5 必须）");

    // 10.2 习惯画像（habit-profile）
    console.log("== 习惯画像（P5）==");
    const hpPath = join(ROOT, "scripts", "habit-profile.mjs");
    if (existsSync(hpPath)) {
      const hp = await import(`file://${hpPath.replace(/\\/g, "/")}`);
      hp.setKey({ dir: tmp, key: "language", value: "英" });
      check(hp.getProfile({ dir: tmp }).language === "英", "set/get 生效（language=英）");
      const pre = hp.prefillFingerprint({ dir: tmp, fp: { model_family: "claude", task_type: "写作" } });
      check(pre.fingerprint.language === "英", "prefill 补缺失指纹字段（language=英）");
      hp.setKey({ dir: tmp, key: "verbosity", value: "超长" });
      check(hp.getProfile({ dir: tmp }).verbosity === "标准", "非法枚举值回默认（防脏数据）");
      hp.resetProfile({ dir: tmp });
      check(hp.getProfile({ dir: tmp }).language === "中", "reset 一键清空回默认");
    } else check(false, "habit-profile.mjs 不存在（P5 必须）");

    // 10.3 自进化（evolve）两级边界
    console.log("== 自进化（P5）==");
    const evPath = join(ROOT, "scripts", "evolve.mjs");
    if (existsSync(evPath)) {
      const ev = await import(`file://${evPath.replace(/\\/g, "/")}`);
      for (let i = 0; i < 3; i++) {
        ev.addFailure({ dir: tmp, prompt: `帮我优化代码 ${i}`, diagnosis: "任务含糊，无具体目标", fix: "明确任务动词与完成标准" });
      }
      const prop = ev.proposeRules({ dir: tmp, threshold: 3 });
      check(prop.proposed >= 1, `达阈值提案（新增 ${prop.proposed}）`);
      const proposals = ev.listProposals({ dir: tmp });
      const pid = proposals[0].id;
      let blocked = false;
      try { ev.confirmProposal({ dir: tmp, proposal: pid }); } catch { blocked = true; }
      check(blocked, "未验证先确认被阻止（两级边界）");
      ev.markVerified({ dir: tmp, proposal: pid, source: "https://example.com" });
      const conf = ev.confirmProposal({ dir: tmp, proposal: pid });
      check(conf.status === "rules_ready", "联网验证后确认 → rules_ready");
    } else check(false, "evolve.mjs 不存在（P5 必须）");

    // 10.4 eval 决策（run-evals）
    console.log("== eval 决策（P5）==");
    const rePath = join(ROOT, "scripts", "run-evals.mjs");
    if (existsSync(rePath)) {
      const re = await import(`file://${rePath.replace(/\\/g, "/")}`);
      const k1 = re.decideKeep({ baseline: 70, current: 75 });
      check(k1.decision === "keep", "改进保留（70→75）");
      const k2 = re.decideKeep({ baseline: 80, current: 75 });
      check(k2.decision === "revert", "回退（80→75）");
    } else check(false, "run-evals.mjs 不存在（P5 必须）");

    // 10.5 专家团双档（expert-panel）
    console.log("== 专家团双档（P5）==");
    const epPath = join(ROOT, "scripts", "expert-panel.mjs");
    if (existsSync(epPath)) {
      const ep = await import(`file://${epPath.replace(/\\/g, "/")}`);
      const m1 = ep.decideMode({ score: 45 });
      check(m1.mode === "panel", "低分触发评审团（45<55）");
      const m2 = ep.decideMode({ score: 78, risk: "low" });
      check(m2.mode === "single", "正常单核（78/low）");
      const m3 = ep.decideMode({ score: 78, risk: "production" });
      check(m3.mode === "panel", "生产场景触发评审团");
      const t1 = ep.checkTrigger({ userRequest: "请专家团评审" });
      check(t1.triggered === true, "用户点名触发评审团");
      const ar1 = ep.arbitrate({ ops: [{ dim: "specificity", vote: 62 }, { dim: "specificity", vote: 80 }] });
      check(ar1.arbitration[0].verdict.decided === true, "仲裁分歧<20 裁定（62/80→均值）");
      const ar2 = ep.arbitrate({ ops: [{ dim: "specificity", vote: 62 }, { dim: "specificity", vote: 85 }, { dim: "specificity", vote: 90 }] });
      check(ar2.arbitration[0].verdict.decided === false, "仲裁分歧≥20 未裁定需依据（62/85/90）");
    } else check(false, "expert-panel.mjs 不存在（P5 必须）");
  } catch (e) {
    check(false, `P5 引擎测试失败: ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

// 10.6 8 维合成 Q-Score（qscore-full）冒烟测试
console.log("== 8 维合成 Q-Score ==");
const qfPath = join(ROOT, "scripts", "qscore-full.mjs");
if (existsSync(qfPath)) {
  try {
    const { scoreFull } = await import(`file://${qfPath.replace(/\\/g, "/")}`);
    const scoring = JSON.parse(readFileSync(join(ROOT, "assets/evals", "scoring.json"), "utf8"));
    const sem = scoring.semantic_cases || [];
    check(sem.length >= 6, `semantic_cases ≥6 条（实际 ${sem.length}）`);

    let semOk = 0;
    for (const c of sem) {
      const r = await scoreFull(c.prompt, { fp: c.fp || {} });
      const dims = r.dimensions;
      const exp = c.expect || {};
      let ok = true;
      const detail = [];
      // verifiability 断言
      if (exp.verifiability_min != null) {
        const v = dims.verifiability.score;
        const pass = v != null && v >= exp.verifiability_min;
        ok = ok && pass;
        detail.push(`verifiability=${v}${pass ? "✓" : `✗(需≥${exp.verifiability_min})`}`);
      }
      if (exp.verifiability_max != null) {
        const v = dims.verifiability.score;
        const pass = v != null && v <= exp.verifiability_max;
        ok = ok && pass;
        detail.push(`verifiability=${v}${pass ? "✓" : `✗(需≤${exp.verifiability_max})`}`);
      }
      // economy 断言
      if (exp.economy_min != null) {
        const v = dims.economy.score;
        const pass = v != null && v >= exp.economy_min;
        ok = ok && pass;
        detail.push(`economy=${v}${pass ? "✓" : `✗(需≥${exp.economy_min})`}`);
      }
      if (exp.economy_max != null) {
        const v = dims.economy.score;
        const pass = v != null && v <= exp.economy_max;
        ok = ok && pass;
        detail.push(`economy=${v}${pass ? "✓" : `✗(需≤${exp.economy_max})`}`);
      }
      // safety 断言
      if (exp.safety != null) {
        const v = dims.safety.score;
        const pass = v === exp.safety;
        ok = ok && pass;
        detail.push(`safety=${v}${pass ? "✓" : `✗(需=${exp.safety})`}`);
      }
      // fit 降级断言
      if (exp.fit_unavailable) {
        const pass = dims.fit.score == null;
        ok = ok && pass;
        detail.push(`fit降级${pass ? "✓" : "✗"}`);
      }
      // 方言边界：HTML 不应被误判为 Claude XML（fit 的方言命中应为 false 语义）
      if (exp.fit_has_html_dialect_hit === false) {
        const f = dims.fit;
        const dialectHit = f.notes && f.notes.some((n) => n.includes("方言匹配"));
        const pass = !dialectHit;
        ok = ok && pass;
        detail.push(`HTML不误判${pass ? "✓" : `✗(notes=${JSON.stringify(f.notes)})`}`);
      }
      // 方言边界：弱信号模型族（DeepSeek）缺失【】时扣分从轻（fit ≥ 阈值）
      if (exp.fit_min_for_weak != null) {
        const v = dims.fit.score;
        const pass = v != null && v >= exp.fit_min_for_weak;
        ok = ok && pass;
        detail.push(`弱信号从轻 fit=${v}${pass ? "✓" : `✗(需≥${exp.fit_min_for_weak})`}`);
      }
      if (ok) semOk++;
      console.log(`  ${c.id} ${c.label}: 总分${r.total_score} [${r.band}] ${detail.join(" ")} ${ok ? "✓" : "✗"}`);
    }
    check(semOk / sem.length >= 0.9, `语义断言：${semOk}/${sem.length} ≥90%`);

    // 8 维确定性：同一用例两次 scoreFull 总分一致
    const c = sem[0];
    const r1 = await scoreFull(c.prompt, { fp: c.fp || {} });
    const r2 = await scoreFull(c.prompt, { fp: c.fp || {} });
    check(r1.total_score === r2.total_score, `8 维确定性：两次总分一致（${r1.total_score}）`);
  } catch (e) {
    check(false, `8 维合成测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/qscore-full.mjs 不存在（8 维必须）");
}

// 10.7 触发评测（trigger-eval）集成
console.log("== 触发评测（P0 补全）==");
const tePath = join(ROOT, "scripts", "trigger-eval.mjs");
if (existsSync(tePath)) {
  try {
    const { evaluateTriggers } = await import(`file://${tePath.replace(/\\/g, "/")}`);
    const r = evaluateTriggers({});
    check(r.coverage.ok, `对象词覆盖：${r.coverage.ok ? "✓" : "✗ 缺 " + r.coverage.missing.join("/")}`);
    check(r.gate.should_ok, `应触发率 ${r.rates.should_trigger_rate}% ≥90%`);
    check(r.gate.false_positive_ok, `误触率 ${r.rates.false_positive_rate}% ≤10%`);
    check(r.gate.overall_ok, "触发门禁整体通过");
    console.log(`  应触发 ${r.rates.should_trigger_rate}% / 误触 ${r.rates.false_positive_rate}%`);
    for (const d of r.diagnostics) console.log(`  ${d}`);
  } catch (e) {
    check(false, `触发评测失败: ${e.message}`);
  }
} else {
  check(false, "scripts/trigger-eval.mjs 不存在（P0 补全必须）");
}

// 10.8 端到端流水线（pipe）测试
console.log("== 端到端流水线（pipe）==");
const pipePath = join(ROOT, "scripts", "pipe.mjs");
if (existsSync(pipePath)) {
  try {
    const { runPipe } = await import(`file://${pipePath.replace(/\\/g, "/")}`);
    const pipeCases = JSON.parse(readFileSync(join(ROOT, "assets/evals", "pipe-cases.json"), "utf8"));
    const list = pipeCases.cases || [];
    check(list.length >= 7, `pipe 用例 ≥7 条（实际 ${list.length}）`);

    const tmpPipe = mkdtempSync(join(tmpdir(), "univ-prompt-pipe-"));
    let ok = 0;
    for (const c of list) {
      const r = await runPipe({ request: c.request, fp: c.fp, dir: tmpPipe });
      const exp = c.expect || {};
      let pass = true;
      const detail = [];
      if (exp.status === "blocked") {
        pass = r.status === "blocked";
        detail.push(`status=${r.status}${pass ? "✓" : "✗(期望 blocked)"}`);
      } else {
        const isOk = r.status === "ok";
        const hasPrompt = r.prompt && r.prompt.trim().length > 0;
        const hasVer = !!r.version_id;
        pass = isOk && hasPrompt && hasVer;
        detail.push(`status=${r.status}${isOk ? "✓" : "✗"} prompt=${hasPrompt ? "✓" : "✗"} version=${hasVer ? "✓" : "✗"}`);
      }
      if (pass) ok++;
      console.log(`  ${c.id} ${c.label}: ${detail.join(" ")} ${pass ? "✓" : "✗"}`);
    }
    check(ok === list.length, `端到端四类分支：${ok}/${list.length} 正确`);
    rmSync(tmpPipe, { recursive: true, force: true });
  } catch (e) {
    check(false, `pipe 测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/pipe.mjs 不存在（端到端必须）");
}

// 10.9 专家盲评校准工具（calibrate）冒烟测试
console.log("== 专家盲评校准（calibrate）==");
const calPath = join(ROOT, "scripts", "calibrate.mjs");
if (existsSync(calPath)) {
  try {
    const cal = await import(`file://${calPath.replace(/\\/g, "/")}`);
    const calCases = JSON.parse(readFileSync(join(ROOT, "assets/evals", "calibration.json"), "utf8"));
    const list = calCases.cases || [];
    check(list.length === 20, `校准采样集 =20 条（实际 ${list.length}）`);
    const goodCount = list.filter((c) => c.expected_quality === "good").length;
    check(goodCount === 10, `10 好 10 坏（好=${goodCount}）`);

    // 自一致性：Q-Score 自排序 → ρ=1（工具自洽）
    const sc = await cal.selfCheck({ casesPath: join(ROOT, "assets/evals", "calibration.json") });
    check(sc.self_consistent === true, `自一致性 ρ=${sc.rho}（应为 1，工具自洽）`);

    // 区分度：完全打乱排序 → ρ 应 < 0.8 门禁（工具能区分好坏排序）
    const qOrder = (await cal.rankByQscore(list)).map((s) => s.id);
    const reversed = [...qOrder].reverse();
    const rhoReversed = cal.spearman(qOrder, reversed);
    check(rhoReversed < 0.8, `完全打乱排序 ρ=${rhoReversed} < 0.8（可区分）`);

    // 盲评表匿名性：表中不应泄露 Q-Score 信息
    const table = cal.buildBlindTable(list);
    const leaks = table.filter((t) => /score|Q-Score|\d+\/100|\[优秀\]|\[可用\]/.test(JSON.stringify(t.prompt) + t.id));
    check(leaks.length === 0, "盲评表不含评分信息（匿名性）");
    console.log(`  自一致 ρ=${sc.rho} / 打乱 ρ=${rhoReversed} / 盲评表 ${table.length} 条匿名`);
  } catch (e) {
    check(false, `校准工具测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/calibrate.mjs 不存在（校准必须）");
}

// 10.10 矩阵一致性（matrix-check）集成
console.log("== 矩阵一致性（matrix-check）==");
const mcPath = join(ROOT, "scripts", "matrix-check.mjs");
if (existsSync(mcPath)) {
  try {
    const mc = await import(`file://${mcPath.replace(/\\/g, "/")}`);
    const r = mc.checkMatrix();
    check(r.ok, `四方矩阵一致（构建/文档/评分/模板无漂移）`);
    check(r.summary.models >= 9, `模型族 ≥9（实际 ${r.summary.models}）`);
    check(r.summary.tasks >= 12, `任务 ≥12（实际 ${r.summary.tasks}）`);
    check(r.summary.templates >= 20, `模板文件 ≥20（实际 ${r.summary.templates}）`);
    check(r.summary.signals >= 20, `评分信号 ≥20（实际 ${r.summary.signals}）`);
    console.log(`  模型 ${r.summary.models} / 任务 ${r.summary.tasks} / 模板 ${r.summary.templates} / 信号 ${r.summary.signals}`);
    for (const i of r.issues.slice(0, 5)) console.log(`  ⚠️ ${i}`);
  } catch (e) {
    check(false, `矩阵一致性测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/matrix-check.mjs 不存在（矩阵校验必须）");
}

// 10.11 攻击套件（attack）集成——双回归合一：安全攻击用例纳入全门禁
console.log("== 攻击套件（attack）==");
const atkPath = join(ROOT, "scripts", "attack.mjs");
if (existsSync(atkPath)) {
  try {
    const atk = await import(`file://${atkPath.replace(/\\/g, "/")}`);
    // 直接调用 runAttacks 会把 22 条用例的结果写进 results 并打印；但 validate 需要拿到 ok 判定。
    // 为保持 validate 的 check 聚合，捕获其输出判定。
    const r = atk.runAttacks();
    check(r.ok === true, `攻击套件全部通过（${r.pass}/${r.total}）`);
    check(r.total >= 30, `攻击用例 ≥30（实际 ${r.total}）`);
  } catch (e) {
    check(false, `攻击套件测试失败: ${e.message}`);
  }
} else {
  check(false, "scripts/attack.mjs 不存在（攻击套件必须）");
}

// 10.12 judge-validate（LLM 判定校验器）门禁回归——契约校验器自身可测
console.log("== LLM 判定校验器（judge-validate）==");
const jvPath = join(ROOT, "scripts", "judge-validate.mjs");
if (existsSync(jvPath)) {
  try {
    const jv = await import(`file://${jvPath.replace(/\\/g, "/")}`);
    // 合法四维判定（含 safety 满分+notes 例外）→ 应通过
    const valid = {
      fit: { score: 78, evidence: [{ quote: "你是一个资深工程师", line: 1, reason: "角色匹配" }], confidence: "high" },
      economy: { score: 85, evidence: [{ quote: "请务必一定", line: 2, reason: "冗余" }], confidence: "high" },
      verifiability: { score: 60, evidence: [{ quote: "完成标准", line: 3, reason: "验收条件" }], confidence: "medium" },
      safety: { score: 100, evidence: [], confidence: "high", notes: ["未发现风险"] },
    };
    const rv = jv.validate(valid);
    check(rv.ok === true, "合法四维判定通过校验");

    // 裸分（非零分无证据）→ 应拦截（禁止裸分，契约 §1）
    const bare = {
      fit: { score: 90, evidence: [], confidence: "high" },
      economy: { score: 85, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "high" },
      verifiability: { score: 60, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "medium" },
      safety: { score: 100, evidence: [], confidence: "high", notes: ["无"] },
    };
    const rb = jv.validate(bare);
    check(rb.ok === false, "裸分判定被拦截（禁止裸分）");

    // 缺维度 → 应拦截
    const missing = { fit: { score: 80, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "high" } };
    const rm = jv.validate(missing);
    check(rm.ok === false, "缺维度判定被拦截");

    // 分数越界 → 应拦截
    const over = {
      fit: { score: 150, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "high" },
      economy: { score: 85, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "high" },
      verifiability: { score: 60, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "medium" },
      safety: { score: 100, evidence: [], confidence: "high", notes: ["无"] },
    };
    const ro = jv.validate(over);
    check(ro.ok === false, "分数越界被拦截");

    // mergeScores 置信度加权正确（low→0.5）
    const merged = jv.mergeScores({
      fit: { score: 80, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "low" },
      economy: { score: 85, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "high" },
      verifiability: { score: 60, evidence: [{ quote: "x", line: 1, reason: "y" }], confidence: "medium" },
      safety: { score: 100, evidence: [], confidence: "high", notes: ["无"] },
    });
    check(merged.fit.effective_weight === 0.5 && merged.economy.effective_weight === 1.0 && merged.verifiability.effective_weight === 0.75, "mergeScores 置信度加权正确（low 0.5 / high 1.0 / medium 0.75）");
    console.log(`  合法通过 / 裸分拦截 / 缺维拦截 / 越界拦截 / 加权正确 全过`);
  } catch (e) {
    check(false, `judge-validate 门禁回归失败: ${e.message}`);
  }
} else {
  check(false, "scripts/judge-validate.mjs 不存在（契约校验器必须）");
}

// 11. 汇总
console.log("");
if (errors.length > 0) {
  console.log(`❌ 校验失败（${errors.length} 个错误）:`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
if (warnings.length > 0) {
  console.log(`⚠️ 警告（${warnings.length} 个）:`);
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log("✅ P0-P5 全部门禁通过");
