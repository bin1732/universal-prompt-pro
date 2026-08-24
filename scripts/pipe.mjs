#!/usr/bin/env node
// pipe.mjs — 端到端流水线（"全能"的最终闭环）
// 流程: 需求+环境指纹 → [L0 安全扫描] → [L3 构建] → [L4 8 维评分] → [L5 版本化快照] → 终版报告
// 串联现有引擎:
//   scan-safety.mjs (L0) → build-prompt.mjs (L3) → qscore-full.mjs (L4) → version-store.mjs (L5)
// 引导层（P7 真实实现）:
//   - 新用户默认开启引导（profile 不存在或 guide=on 时）
//   - 可选关闭: --no-guide CLI 参数 或 user_level=expert 或 profile.guide=off
//   - 每环节（L0-L5）在引导开启时输出引导点（不改变流程/评分，仅附加说明）
// 设计原则:
//   1. 安全优先: L0 命中红线/注入 → 立即拒绝，不构建（安全优先，命中即拦截）
//   2. 单一入口: 用户只需要给 需求 + 环境指纹，其余全自动
//   3. 可追溯: 每次流水线产出版本快照（before/after 可对比）
//   4. 目录可注入: --dir <path> 测试用临时目录
// 用法:
//   node scripts/pipe.mjs --request "重构 getUserData() 为 async/await" --fp '{"model_family":"claude","platform_form":"chat","task_type":"代码"}'
//   node scripts/pipe.mjs --request "..." --fp '...' --no-guide   # 专家模式：零引导
//   node scripts/pipe.mjs --request "..." --fp '...' --json
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let mods = null;
async function getModules() {
  if (mods) return mods;
  const [safety, build, qscore, versions, habit, searchCache, token] = await Promise.all([
    import(`file://${join(ROOT, "scripts", "scan-safety.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "build-prompt.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "qscore-full.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "version-store.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "habit-profile.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "search-cache.mjs").replace(/\\/g, "/")}`),
    import(`file://${join(ROOT, "scripts", "token-count.mjs").replace(/\\/g, "/")}`),
  ]);
  mods = { safety, build, qscore, versions, habit, searchCache, token };
  return mods;
}

// ================= 引导层（P7 真实实现） =================
// guide 解析优先级（高→低）:
//   1. 显式参数 guide ("on"/"off")（来自 --no-guide 或调用方）
//   2. fp.user_level === "expert" → off（专家模式零引导）
//   3. habit-profile 的 guide 字段（默认 "on"——新用户默认开启）
async function resolveGuide({ fp, explicitGuide = null, profileDir = null, habit }) {
  const enabled = explicitGuide != null
    ? explicitGuide === "on"
    : fp.user_level === "expert"
      ? false
      : (habit.getProfile({ dir: profileDir ?? undefined }).guide ?? "on") === "on";
  return { enabled, source: explicitGuide != null ? "显式参数" : fp.user_level === "expert" ? "user_level=expert" : "habit-profile（默认 on）" };
}

// 每环节引导点：不改变流程/评分，仅附加说明
function guidePoints({ scan, fp, built, score, template }) {
  const points = [];
  // L0 安全
  if (scan.level === "yellow") points.push("L0 安全：检测到 PII，已脱敏后继续（输出同样脱敏）。");
  else if (scan.level === "gray") points.push("L0 安全：检测到灰线领域（医疗/法律等），输出将附专业声明。");
  else points.push("L0 安全：输入已通过扫描（无注入/红线/PII/灰线）。");
  // L2 环境
  const missing = ["model_family", "platform_form", "task_type"].filter((k) => !fp[k]);
  points.push(missing.length
    ? `L2 环境：缺少 ${missing.join("/")}，Fit 评分可能降级——建议补全环境指纹以获得更准的适配评分。`
    : `L2 环境：已识别 模型=${fp.model_family} / 平台=${fp.platform_form} / 任务=${fp.task_type}。`);
  // L3 构建
  points.push(`L3 构建：已按任务类型选择模板 ${template}（占位符 {…} 需替换为你的实际内容）。`);
  // L4 评分
  const bandTips = { "需重写": "建议先补齐角色/任务/格式/边界再使用。", "定向修补": "按短板维度修补后可提升。", "可用": "可用于多数场景，仍可优化。", "优秀": "结构完整，可直接使用。" };
  points.push(`L4 评分：总分 ${score.total_score} [${score.band}] —— ${bandTips[score.band] || ""}${score.weak_spots.length ? " 短板：" + score.weak_spots.map((w) => w.dim).join("/") : ""}`);
  // L5 输出
  points.push("L5 使用：将下方提示词粘贴到目标模型即可使用；可再次调用本 skill 优化/压缩/迁移。");
  return points;
}

export async function runPipe({ request, fp = {}, dir = null, target_budget = null, save = true, guide = null, profileDir = null, semanticOverride = null }) {
  if (!request || !request.trim()) throw new Error("缺少 request（需求）");
  const { safety, build, qscore, versions, habit, searchCache, token } = await getModules();

  const pipeline = { started_at: new Date().toISOString().slice(0, 19), stages: [] };
  const stage = (name, data) => { pipeline.stages.push({ stage: name, ...data }); return data; };

  // ---- L0 安全前置（安全优先，命中即拦截）----
  const scan = safety.scanSafety(request);
  stage("L0 安全扫描", { level: scan.level, hits: scan.hits.length });
  if (scan.level === "red") {
    return {
      status: "blocked",
      reason: scan.reason,
      hits: scan.hits,
      pipeline,
      message: "输入命中安全红线，已阻止构建（安全优先，命中即拦截）",
    };
  }

  // ---- L2 环境指纹（由调用方提供，缺字段构建引擎会标注 Fit 降级）----
  stage("L2 环境指纹", { fp: { model_family: fp.model_family, platform_form: fp.platform_form, task_type: fp.task_type } });

  // ---- L3 构建 ----
  const built = build.buildPrompt({ ...fp, request });
  stage("L3 构建", { template: built.meta.template, techniques: built.techniques.length });
  const prompt = built.prompt;

  // ---- 情报检索建议真实落盘（§3.4 search-cache，同环境重复检索零成本） ----
  // 有检索建议时写入 search-cache（键 = 模型族+任务类型摘要）；写失败不阻断主流程（诚实降级，但记录错误可诊断）
  let search_cached = false;
  let search_cache_error = null;
  if (built.search_suggestions && built.search_suggestions.length) {
    try {
      const cacheKey = `${fp.model_family || "?"}::${fp.task_type || "?"}`;
      searchCache.put({
        dir: join(ROOT, "data", "search-cache"),
        key: cacheKey,
        data: { query: built.search_suggestions[0].query, node: built.search_suggestions[0].node, count: built.search_suggestions.length },
      });
      search_cached = true;
    } catch (e) {
      search_cached = false;
      search_cache_error = e.message; // 不静默：记录错误供诊断（诚实降级）
    }
  }
  stage("L3 情报缓存", { cached: search_cached, suggestions: built.search_suggestions?.length || 0, error: search_cache_error });

  // ---- L4 8 维评分（semanticOverride：宿主 LLM 判定结果，经 judge-validate 校验后覆盖语义 4 维） ----
  const score = await qscore.scoreFull(prompt, { fp, target_budget, semanticOverride });
  stage("L4 8 维评分", { total: score.total_score, band: score.band, weak: score.weak_spots.length, llm_override: !!semanticOverride });

  // ---- L4 token 报告（L5 快速模式"token 报告"承诺的落实）----
  // 预算来源优先级：显式 target_budget > 环境指纹 context_budget > 无预算（仅冗余检测）
  const budget = target_budget ?? fp.context_budget ?? null;
  const tokenReportData = await token.tokenReport(prompt);
  const budgetData = token.budgetReport(prompt, budget);
  const redundancyData = token.detectRedundancy(prompt);
  const tokenInfo = {
    estimate_tokens: tokenReportData.estimate.tokens,
    target_budget: budgetData.target_budget,
    deviation_pct: budgetData.deviation_pct,
    band: budgetData.band,
    redundancy_hits: redundancyData.findings.length,
    redundancy: redundancyData.findings.slice(0, 5).map((f) => ({ rule: f.rule, quote: f.quote.slice(0, 24) })),
  };
  stage("L4 token 报告", tokenInfo);

  // ---- L5 版本化快照 ----
  let version = null;
  if (save) {
    version = versions.snapshot({
      dir: dir || join(ROOT, "data", "versions"),
      prompt,
      score: score.total_score,
      dims: Object.fromEntries(Object.entries(score.dimensions).map(([k, v]) => [k, v.score])),
      fingerprint: fp,
      intent: "pipe",
    });
    stage("L5 版本化", { version_id: version.id });
  }

  // ---- L5 before/after 对比（L4 "产出 before/after 强制对比表"承诺的落实）----
  // 与同意图上一版本对比：Q-Score 增量 + 各维增量；无上一版本则如实标注"首次构建"
  let compare = null;
  if (save) {
    const vdir = dir || join(ROOT, "data", "versions");
    const prevs = versions.listVersions({ dir: vdir })
      .filter((v) => v.id !== version.id && v.intent === "pipe")
      .sort((a, b) => (a.ts > b.ts ? -1 : 1));
    if (prevs.length) {
      compare = versions.compareVersions({ dir: vdir, from: prevs[0].id, to: version.id });
    }
  }
  stage("L5 before/after 对比", compare
    ? { from: compare.from.id, to: compare.to.id, qscore_delta: compare.qscore_delta, dim_changed: Object.keys(compare.dim_deltas || {}).length, prompt_changed: compare.prompt_changed }
    : { note: "无上一版本，未生成对比（首次构建）" });

  // ---- 引导层：解析开关 + 每环节引导点（不改变流程/评分） ----
  const guideState = await resolveGuide({ fp, explicitGuide: guide, profileDir, habit });
  const result = {
    status: "ok",
    prompt,
    score: { total: score.total_score, band: score.band, weak_spots: score.weak_spots },
    token: tokenInfo,
    compare,
    version_id: version ? version.id : null,
    pipeline,
  };
  if (guideState.enabled) {
    result.guide = {
      enabled: true,
      source: guideState.source,
      points: guidePoints({ scan, fp, built, score, template: built.meta.template }),
    };
  } else {
    result.guide = { enabled: false, source: guideState.source, note: "引导已关闭（专家模式），仅输出终版 + 评分证据表。" };
  }
  return result;
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法: node " + process.argv[1].split(/[\\/]/).pop() + " [选项]（完整用法见脚本头部注释）");
    process.exit(0);
  }
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const wantJson = args.includes("--json");
  const noGuide = args.includes("--no-guide");
  const request = opt("request");
  let fp = {};
  const fpRaw = opt("fp");
  if (fpRaw) {
    try {
      fp = JSON.parse(fpRaw);
    } catch {
      console.error(`错误: --fp 不是合法 JSON: ${fpRaw.slice(0, 40)}…`);
      process.exit(2);
    }
  }
  const dir = opt("dir") || null;
  const budget = opt("budget") != null ? Number(opt("budget")) : null;
  const profileDir = opt("profile-dir") || null; // 指定 habit-profile 目录（测试/隔离用）
  // --judge <json>：宿主 LLM 语义判定结果（契约 references/llm-judge-prompt.md），覆盖语义 4 维
  let semanticOverride = null;
  const judgeRaw = opt("judge");
  if (judgeRaw) {
    try {
      semanticOverride = JSON.parse(judgeRaw);
    } catch {
      console.error("错误: --judge 不是合法 JSON（已忽略，回退规则版语义评分）");
    }
  }

  try {
    const r = await runPipe({ request, fp, dir, target_budget: budget, guide: noGuide ? "off" : null, profileDir, semanticOverride });
    if (wantJson) {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    } else if (r.status === "blocked") {
      console.log(`⛔ 已阻止构建（${r.reason}）`);
      for (const h of r.hits) console.log(`  - [${h.level}] "${h.quote}" ← ${h.rule}`);
      console.log("输入命中安全红线，未进入构建（安全优先，命中即拦截）");
    } else {
      console.log("=== 端到端流水线 ===");
      for (const s of r.pipeline.stages) {
        console.log(`  [${s.stage}] ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "stage")))}`);
      }
      console.log("");
      console.log(`Q-Score: ${r.score.total}/100 [${r.score.band}]`);
      if (r.score.weak_spots.length) console.log(`短板: ${r.score.weak_spots.map((w) => `${w.dim}:${w.score}`).join(", ")}`);
      if (r.version_id) console.log(`版本快照: ${r.version_id}`);
      // 引导输出（开启时显示每环节引导点）
      if (r.guide && r.guide.enabled) {
        console.log("");
        console.log("【引导（新用户模式，--no-guide 可关闭）】");
        for (const p of r.guide.points) console.log(`  · ${p}`);
      } else if (r.guide) {
        console.log(`【引导已关闭（${r.guide.source}）】${r.guide.note || ""}`);
      }
      console.log("");
      console.log("---- 终版提示词 ----");
      console.log(r.prompt);
    }
  } catch (e) {
    // 顶层错误包装：不泄露堆栈（优雅失败，非 0 退出，无 ModuleJob 堆栈）
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
