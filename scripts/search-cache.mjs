#!/usr/bin/env node
// search-cache.mjs — 情报检索缓存（§3.4 Lv3 真实实现：TTL 缓存 + 可复用）
// 能力:
//   1. put: 写入检索建议（键 = 环境指纹摘要，TTL 默认 7 天）
//   2. get: 命中且未过期返回数据；过期返回 null（防重复搜索烧 token）
//   3. list / clear: 查看与清空（可一键重置）
//   4. 目录可注入: --dir <path> 测试用临时目录
// 设计原则: 确定性（同键同数据）；TTL 过期即失效（不返回陈旧缓存，诚实边界）
// 用法:
//   node scripts/search-cache.mjs put --key claude-code --data '{"query":"最新能力"}' --ttl 7
//   node scripts/search-cache.mjs get --key claude-code
//   node scripts/search-cache.mjs list
//   node scripts/search-cache.mjs clear
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ensureDir } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "assets", "data", "search-cache");
const DEFAULT_TTL_DAYS = 7;

function keyHash(key) { return createHash("sha256").update(String(key)).digest("hex").slice(0, 16); }
function ts() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
}

// ================= 核心 API =================
export function put({ dir = DEFAULT_DIR, key, data, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!key) throw new Error("put 需要 key");
  ensureDir(dir);
  const id = keyHash(key);
  const record = {
    id, key, data,
    created_ts: ts(),
    expires_ts: new Date(Date.now() + ttlDays * 24 * 3600 * 1000).toISOString().slice(0, 19),
    ttl_days: ttlDays,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

export function get({ dir = DEFAULT_DIR, key, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!key) throw new Error("get 需要 key");
  const id = keyHash(key);
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) return { hit: false, reason: "miss" };
  try {
    const rec = JSON.parse(readFileSync(p, "utf8"));
    // TTL 检查：过期则删除并返回 miss（不返回陈旧缓存，诚实边界）
    const expires = new Date(rec.expires_ts.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6"));
    if (expires.getTime() < Date.now()) {
      rmSync(p, { force: true });
      return { hit: false, reason: "expired", id };
    }
    return { hit: true, id, data: rec.data, created_ts: rec.created_ts, expires_ts: rec.expires_ts };
  } catch {
    rmSync(p, { force: true }); // 损坏缓存删除
    return { hit: false, reason: "corrupt" };
  }
}

export function list({ dir = DEFAULT_DIR } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

export function clear({ dir = DEFAULT_DIR } = {}) {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) rmSync(join(dir, f), { force: true });
  return files.length;
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
      case "put":
        out = put({ dir, key: opt("key"), data: JSON.parse(opt("data") || "{}"), ttlDays: opt("ttl") ? Number(opt("ttl")) : DEFAULT_TTL_DAYS });
        break;
      case "get":
        out = get({ dir, key: opt("key") });
        break;
      case "list":
        out = list({ dir });
        break;
      case "clear":
        out = { cleared: clear({ dir }) };
        break;
      default:
        throw new Error("用法: put|get|list|clear（--dir/--key/--data/--ttl 可注入）");
    }
    if (wantJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else if (cmd === "get") {
      console.log(out.hit ? `✓ 缓存命中（id=${out.id}）: ${JSON.stringify(out.data)}` : `✗ 未命中（${out.reason}）`);
    } else if (cmd === "put") {
      console.log(`✓ 已写入缓存（id=${out.id}, TTL ${out.ttl_days} 天）`);
    } else if (cmd === "list") {
      console.log(`缓存条目: ${out.length} 条`);
      for (const c of out) console.log(`  ${c.id} key=${c.key} TTL${c.ttl_days}天 创建${c.created_ts}`);
    } else if (cmd === "clear") {
      console.log(`已清空 ${out.cleared} 条缓存`);
    }
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}
