#!/usr/bin/env node
// lib.mjs — 公共工具库（消除跨脚本重复：ROOT/clamp/ts/ensureDir/isMain）
// 用途: 被各引擎脚本 import，避免 16 个脚本各自复制同一段工具代码
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录（脚本位于 scripts/ 下，故 ..）
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// 确定性时间戳（YYYYMMDDHHMMSS）
export function ts() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
}
