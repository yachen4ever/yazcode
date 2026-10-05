#!/usr/bin/env node
// T1 防回流门禁 —— vendored office 四件套 skill（docx/xlsx/pptx/pdf，来源 MiniMaxAI/minimax-code，
// MIT）已完成去品牌化改造，本脚本防止宿主品牌与宿主专有端口残留回流：
//   1) 大小写不敏感命中 "minimax" / "mavis"（品牌名与宿主 agent 名，已覆盖 __MAVIS_ 环境变量前缀等变体）；
//   2) 端口 ":5321"（宿主本地 runtime 端口，撞端口会误打真实服务；(?!\d) 防止误配更长数字，
//      localhost / 0.0.0.0 等写法同样命中）。
// 允许名单：LICENSE* 文件（许可原文保持原样），以及 provenance 锚点行
// （"MiniMaxAI/minimax-code" 来源链接 / "Copyright (c) 2026 MiniMax" 版权行）——这些行用于保留来源追溯，不得删除也不算残留。
// 命中任何一行则打印 `文件:行号: 内容` 并以退出码 1 失败；全部干净则打印统计并以 0 退出。

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// 以脚本自身位置锚定，从仓库子目录运行同样有效。
const ROOT = join(import.meta.dirname, "..", ".agents", "skills");
const MAX_BYTES = 2 * 1024 * 1024; // 超过 2MB 的单文件跳过并告警（防止把生成物/大二进制读进内存）。
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "zip", "docx", "xlsx", "pptx", "ttf", "otf",
  "woff", "woff2", "pdf", "ico", "icns", "dll", "exe", "bin",
]);
// 大小写不敏感的品牌残留；端口单独按字面匹配。
const CASE_INSENSITIVE = [/minimax/i, /mavis/i];
const CASE_SENSITIVE = [/:5321(?!\d)/];
// 允许名单行：来源锚点（provenance 块）。
const ALLOWED_LINE = /MiniMaxAI\/minimax-code|Copyright \(c\) 2026 MiniMax/;

function isAllowedFile(relativePath) {
  const base = relativePath.split("/").pop() ?? "";
  // 只豁免许可文件本体，避免其他以 LICENSE 开头的普通文档借名免检。
  return /^LICENSE(\.(txt|md))?$/i.test(base);
}

async function collectTextFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push({ absolute: join(dir, entry.name), relative });
    }
  }
  return files;
}

let scanned = 0;
let skippedBinary = 0;
let skippedLarge = 0;
const hits = [];

const allFiles = await collectTextFiles(ROOT);
for (const { absolute, relative } of allFiles) {
  if (isAllowedFile(relative)) continue;
  const ext = relative.split(".").pop()?.toLowerCase() ?? "";
  if (BINARY_EXTENSIONS.has(ext)) {
    skippedBinary += 1;
    continue;
  }
  const info = await stat(absolute);
  if (info.size > MAX_BYTES) {
    skippedLarge += 1;
    console.warn(`[skill-residue] warning: 跳过超过 ${MAX_BYTES} 字节的文件 ${relative}`);
    continue;
  }
  const buffer = await readFile(absolute);
  // null 字节兜底：扩展名不在二进制名单但内容含 NUL 的按二进制跳过。
  if (buffer.includes(0)) {
    skippedBinary += 1;
    continue;
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  scanned += 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOWED_LINE.test(line)) continue;
    const matched = CASE_INSENSITIVE.some((re) => re.test(line)) || CASE_SENSITIVE.some((re) => re.test(line));
    if (matched) {
      hits.push(`${relative}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
}

if (hits.length > 0) {
  console.error(`[skill-residue] 发现 ${hits.length} 处宿主品牌/端口残留（T1 防回流门禁）：`);
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
console.log(
  `[skill-residue] 干净：扫描 ${scanned} 个文本文件，` +
    `跳过二进制 ${skippedBinary} 个、超大 ${skippedLarge} 个，0 处残留。`,
);
