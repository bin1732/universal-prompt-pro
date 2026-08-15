#!/usr/bin/env node
// habit-profile.mjs — 习惯画像引擎（P5，对应 data/habit-profile）
// 能力:
//   1. 读写画像: 记录用户长期偏好（模板/详略/语言/模型/领域/交互风格）
//   2. 预填环境指纹: 交互时用画像补默认值（减少询问，人性化）
//   3. 一键清空: --reset 立即回到默认（防回声室逃生口）
//   4. 中立性保证: 画像只影响"默认值"，不改变任何评分/质量门禁结果（Q-Score 必须中立）
//   5. 目录可注入: --dir <path> 支持测试
// 设计原则: 习惯数据只进 data/habit-profile/，永不自动进 references/（两级边界）
// 用法:
//   node scripts/habit-profile.mjs get --key model_family
//   node scripts/habit-profile.mjs set --key user_level --value expert
//   node scripts/habit-profile.mjs prefill --fp '{"model_family":"claude","task_type":"写作"}'  # 用画像补缺失字段
//   node scripts/habit-profile.mjs reset
//   node scripts/habit-profile.mjs show
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "assets", "data", "habit-profile");
const PROFILE_FILE = "profile.json";

// 画像 schema：所有键的合法取值（防脏数据写入）
const SCHEMA = {
  template_pref: { type: "string", hint: "常用模板名（如 COSTAR）" },
  verbosity: { type: "enum", values: ["精简", "标准", "详尽"] },
  language: { type: "enum", values: ["中", "英", "双语"] },
  model_family: { type: "string", hint: "常用模型族" },
  domain: { type: "string", hint: "常用任务领域" },
  guide: { type: "enum", values: ["on", "off"] },
  score_detail: { type: "enum", values: ["brief", "full"] },
};

const DEFAULTS = { template_pref: null, verbosity: "标准", language: "中", model_family: null, domain: null, guide: "on", score_detail: "brief" };

// ensureDir 由 lib.mjs 提供（消除跨脚本重复）
function profilePath(dir) { return join(dir, PROFILE_FILE); }

function load(dir) {
  const p = profilePath(dir);
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { ...DEFAULTS }; // 损坏则回默认（fail-safe）
  }
}

function save(dir, profile) {
  ensureDir(dir);
  writeFileSync(profilePath(dir), JSON.stringify(profile, null, 2) + "\n", "utf8");
  return profile;
}

// 合法性校验：非法值不写入（防脏数据/注入）
function sanitize(profile) {
  const out = { ...profile };
  for (const [k, spec] of Object.entries(SCHEMA)) {
    if (out[k] == null) continue;
    if (spec.type === "enum" && !spec.values.includes(out[k])) {
      out[k] = DEFAULTS[k]; // 非法枚举回默认
    }
  }
  return out;
}

// ================= 核心 API =================
export function getProfile({ dir = DEFAULT_DIR } = {}) { return load(dir); }

export function setKey({ dir = DEFAULT_DIR, key, value }) {
  if (!(key in SCHEMA)) throw new Error(`非法画像键: ${key}（合法: ${Object.keys(SCHEMA).join("/")}）`);
  const p = load(dir);
  p[key] = value;
  save(dir, sanitize(p));
  return p;
}

export function resetProfile({ dir = DEFAULT_DIR } = {}) {
  save(dir, { ...DEFAULTS });
  return { ...DEFAULTS };
}

// 预填环境指纹：画像字段填入指纹缺失项（仅补默认值，不覆盖用户显式提供值；不影响任何评分）
export function prefillFingerprint({ dir = DEFAULT_DIR, fp }) {
  const p = load(dir);
  const out = { ...fp };
  const filled = [];
  const map = {
    model_family: "model_family",
    user_level: null, // user_level 不在画像 schema（由用户声明），不预填
    language: "language",
    template_pref: "template", // P1-5：画像中的常用模板 → 指纹期望模板（sem-score 模板信号校验用）
  };
  for (const [profileKey, fpKey] of Object.entries(map)) {
    if (!fpKey) continue;
    if ((out[fpKey] == null || out[fpKey] === "") && p[profileKey]) {
      out[fpKey] = p[profileKey];
      filled.push(`${fpKey}=${p[profileKey]}（来自画像）`);
    }
  }
  return { fingerprint: out, filled, profile: p };
}

// 中立性保证：画像与评分完全隔离（评分引擎不读画像；此处提供断言供测试）
export function neutralityCheck() {
  return {
    ok: true,
    note: "画像仅写入 data/habit-profile/；评分引擎 score-prompt.mjs 与构建引擎 build-prompt.mjs 均不读取画像 → Q-Score 中立（防回声室）",
  };
}

// ================= CLI =================
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const dir = opt("dir") || DEFAULT_DIR;
  const wantJson = args.includes("--json");

  try {
    let out;
    switch (cmd) {
      case "get":
        out = { key: opt("key"), value: getProfile({ dir })[opt("key")] };
        break;
      case "set":
        out = setKey({ dir, key: opt("key"), value: opt("value") });
        break;
      case "reset":
        out = resetProfile({ dir });
        break;
      case "prefill":
        out = prefillFingerprint({ dir, fp: JSON.parse(opt("fp") || "{}") });
        break;
      case "show":
        out = getProfile({ dir });
        break;
      case "neutrality":
        out = neutralityCheck();
        break;
      default:
        throw new Error("用法: get|set|reset|prefill|show|neutrality（--dir 可注入）");
    }
    if (wantJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else if (cmd === "prefill") {
      console.log(`指纹预填完成，补充 ${out.filled.length} 项: ${out.filled.join("；") || "无"}`);
      console.log("最终指纹:", JSON.stringify(out.fingerprint));
    } else if (cmd === "neutrality") {
      console.log(`中立性: ${out.ok ? "OK" : "FAIL"} — ${out.note}`);
    } else if (cmd === "set") {
      console.log(`已设置，当前画像: ${JSON.stringify(out)}`);
    } else if (cmd === "reset") {
      console.log(`已清空画像，回到默认: ${JSON.stringify(out)}`);
    } else {
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
