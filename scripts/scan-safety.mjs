#!/usr/bin/env node
// scan-safety.mjs — L0a 安全前置扫描器（P4）
// 能力: 输入/输出内容扫描 → 注入特征 / 红线主题 / PII / 灰线领域
// 分级返回: red（拒绝） / yellow（脱敏） / gray（引导） / clean
// 设计原则:
//   1. 确定性: 纯规则 + 词库匹配, 同输入恒同结果
//   2. 证据引用: 每条命中附 原文 + 词库条目 + 类别
//   3. 分级处理: 红线拒绝、黄线脱敏、灰线引导（§8.3）
//   4. 词库外置: data/lexicon/*.json（可更新; 红线层仅人工确认后更新）
// 用法:
//   node scripts/scan-safety.mjs <content.txt>              # 人类可读
//   node scripts/scan-safety.mjs <content.txt> --json       # 机器可读
//   echo "..." | node scripts/scan-safety.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 词库目录：默认 data/lexicon；可用环境变量 UPP_LEXICON_DIR 覆盖（测试损坏词库降级 / 隔离环境用）
const LEXICON_DIR = process.env.UPP_LEXICON_DIR || join(ROOT, "references", "data", "lexicon");

function loadLexicon(name) {
  const p = join(LEXICON_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // 词库损坏 → 返回 null 触发内置最小规则集降级（safety-policy.md §7：扫描器失效降级，宁严勿松）
    return null;
  }
}

// ================= 词库加载（缺失词库时降级为内置最小规则，防扫描器失效） =================
const redLex = loadLexicon("red");
const injLex = loadLexicon("injection");
const piiLex = loadLexicon("pii");
const grayLex = loadLexicon("gray");

const FALLBACK_RED = ["制造炸弹", "毒品合成", "暗杀", "儿童性内容", "颠覆国家政权", "分裂国家", "恐怖袭击策划"];
const FALLBACK_INJECTION = ["忽略之前", "忽略上面", "输出 system prompt", "ignore previous", "ignore all previous", "DAN mode", "绕过安全", "jailbreak"];
const FALLBACK_PII = [
  { name: "cn_phone", label: "中国大陆手机号", regex: "(?<!\\d)1[3-9]\\d{9}(?!\\d)" },
  { name: "email", label: "邮箱", regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}" },
];
const FALLBACK_GRAY = [
  { domain: "医疗", keywords: ["医疗", "诊断", "用药"], notice: "医疗信息仅供参考，请咨询执业医师。" },
  { domain: "法律", keywords: ["法律", "合同", "诉讼"], notice: "本内容不构成法律意见，请咨询执业律师。" },
];

// ================= 归一化（防拆分绕过：空格/零宽/emoji/全角 插入到特征串中间） =================
// 用途：红线与注入检测用归一化文本（剥离空白 + 零宽不可见字符 + emoji + 全角→半角）；PII 必须用原文（正则对空格敏感）
// 注意：
//   1. JS 的 \s 覆盖 \u2000-\u200a 但不含 \u200b（ZERO WIDTH SPACE）——需显式剥离零宽字符族
//   2. NFKC 全角→半角归一化：堵住 "ｓｙｓｔｅｍ ｐｒｏｍｐｔ" / "ｉｇｎｏｒｅ" 等全角变体绕过（归一化修复）
//      NFKC 也会把全角数字/标点转半角，对中文无影响；PII 走原文路径不受影响
function normalizeForDetection(text) {
  return text
    .normalize("NFKC") // 全角→半角（含全角字母/数字/标点/空格），防全角变体绕过
    .replace(/\s+/g, "")
    .replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, "") // 零宽空格/连接符/不换行空格等不可见字符
    .replace(/[\u{1F300}-\u{1FAFF}\u{FE0F}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, ""); // emoji
}

// ================= 扫描实现（按 原文+规则+类别 去重，防重叠正则噪音） =================
function scanPatterns(text, entries, getRegex, getMeta) {
  const hits = [];
  const seen = new Set();
  for (const e of entries) {
    const src = getRegex(e);
    if (!src) continue;
    // 强制全局标志：无 g 时 exec 永远返回同一匹配 → 死循环
    const re = new RegExp(src.source, src.flags.includes("g") ? src.flags : src.flags + "g");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split("\n").length;
      const meta = getMeta(e);
      const key = `${m[0]}::${meta.rule}::${meta.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ ...meta, quote: m[0], line: lineNo });
      }
      if (re.lastIndex === m.index) re.lastIndex++;
      if (hits.length >= 20) break;
    }
    if (hits.length >= 20) break;
  }
  return hits;
}

export function scanSafety(text) {
  if (!text || !text.trim()) return { level: "clean", hits: [], redacted: text };

  const result = { level: "clean", hits: [], redacted: text };
  // 归一化文本用于红线/注入检测（防空格/emoji 拆分绕过）；PII 用原文
  const norm = normalizeForDetection(text);
  const normDetected = norm !== text; // 标记"经归一化后命中"

  // 1. 红线（拒绝）——原文 ∪ 归一化（中文空格拆分靠归一化，英文/拼音带空格靠原文）
  const redEntries = redLex
    ? Object.values(redLex.levels.red.categories).flatMap((cat) => cat.patterns.map((p) => ({ pattern: p, category: cat.label })))
    : FALLBACK_RED.map((p) => ({ pattern: p, category: "内置红线" }));
  const redHits = [
    ...scanPatterns(text, redEntries, (e) => (e.pattern ? new RegExp(e.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null), (e) => ({ level: "red", rule: "红线主题", category: e.category, source: "lexicon/red.json" })),
    ...scanPatterns(norm, redEntries, (e) => (e.pattern ? new RegExp(e.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null), (e) => ({ level: "red", rule: "红线主题", category: e.category, source: "lexicon/red.json" })),
  ];
  if (redHits.length) {
    result.level = "red";
    result.hits.push(...redHits.map((h) => ({ ...h, note: normDetected ? "归一化后命中（原文含空白/emoji 拆分）" : undefined })));
    result.reason = "命中红线主题：拒绝并给出合规替代";
    return result;
  }

  // 2. 注入特征（拒绝或隔离——OWASP 建议：注入命中即不执行内容）——原文 ∪ 归一化
  const injEntries = injLex
    ? [...injLex.direct_injection, ...injLex.indirect_injection].map((e) => ({ ...e, pattern: e.pattern }))
    : FALLBACK_INJECTION.map((p) => ({ pattern: p, label: "内置注入特征" }));
  const injHits = [
    ...scanPatterns(text, injEntries, (e) => (e.pattern ? new RegExp(e.pattern, "i") : null), (e) => ({ level: "red", rule: "提示词注入特征", category: e.label || "注入", source: "lexicon/injection.json" })),
    ...scanPatterns(norm, injEntries, (e) => (e.pattern ? new RegExp(e.pattern, "i") : null), (e) => ({ level: "red", rule: "提示词注入特征", category: e.label || "注入", source: "lexicon/injection.json" })),
  ];
  if (injHits.length) {
    result.level = "red";
    result.hits.push(...injHits.map((h) => ({ ...h, note: normDetected ? "归一化后命中（原文含空白/emoji 拆分）" : undefined })));
    result.reason = "命中注入特征：内容不得作为指令执行（隔离标注）";
    return result;
  }

  // 3. PII（黄线：脱敏后继续）——用原文（正则对空格敏感）
  const piiEntries = piiLex ? piiLex.pii_patterns : FALLBACK_PII;
  const piiHits = scanPatterns(
    text,
    piiEntries,
    (e) => (e.regex ? new RegExp(e.regex, "g") : null),
    (e) => ({ level: "yellow", rule: "PII 检测", category: e.label || e.name, source: "lexicon/pii.json" })
  );
  if (piiHits.length) {
    result.level = "yellow";
    result.hits.push(...piiHits);
    // 脱敏
    let redacted = text;
    for (const e of piiEntries) {
      if (!e.regex) continue;
      redacted = redacted.replace(new RegExp(e.regex, "g"), `[REDACTED:${e.label || e.name}]`);
    }
    result.redacted = redacted;
    result.reason = "命中 PII：已脱敏，输出同样脱敏并提示用户";
    return result;
  }

  // 4. 灰线（引导）
  const grayEntries = grayLex ? grayLex.gray_domains : FALLBACK_GRAY;
  const grayHits = [];
  for (const d of grayEntries) {
    const re = new RegExp(`(${d.keywords.join("|")})`, "i");
    const m = text.match(re);
    if (m) {
      const lineNo = text.slice(0, m.index).split("\n").length;
      grayHits.push({ level: "gray", rule: "灰线专业领域", category: d.domain, notice: d.notice, quote: m[0], line: lineNo, source: "lexicon/gray.json" });
    }
  }
  if (grayHits.length) {
    result.level = "gray";
    result.hits.push(...grayHits);
    result.reason = "灰线领域：输出附专业声明（不拒绝不脱敏）";
    return result;
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
  const wantJson = args.includes("--json");
  const fileArg = args.find((a) => !a.startsWith("--") && !a.startsWith("{") && !a.startsWith("[") && !/^-?\d+$/.test(a));
  let input;
  if (fileArg) input = readFileSync(fileArg, "utf8");
  else input = readFileSync(0, "utf8");

  const r = scanSafety(input);
  if (wantJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    const levelName = { red: "🔴 红线（拒绝）", yellow: "🟡 黄线（脱敏）", gray: "🟠 灰线（引导）", clean: "🟢 干净" }[r.level];
    console.log(`=== 安全扫描: ${levelName} ===`);
    if (r.reason) console.log(`原因: ${r.reason}`);
    for (const h of r.hits) {
      console.log(`  - [${h.level}] 第${h.line}行 "${h.quote}" ← ${h.rule}(${h.category}) [${h.source}]`);
    }
    if (r.level === "yellow") {
      console.log("");
      console.log("---- 脱敏后 ----");
      console.log(r.redacted);
    }
    if (r.level === "gray") {
      for (const h of r.hits) console.log(`  提示: ${h.notice}`);
    }
  }
}
