#!/usr/bin/env node
/**
 * vendor/openviking 上游漂移检测（走 GitHub trees API 的 blob sha 比对，不下载文件内容）。
 *
 * 数据源：
 * - 同步基线：third-party/copied-components.json 的 openviking-client-integration.referenceRevision
 *   （仅用于展示 vendored 时的上游版本；内容比对以本地文件为基准）。
 * - 上游：volcengine/OpenViking 的 latest release tag（与「跟随 release 同步」策略一致）。
 *
 * 比对语义（正向，对应 vendor/openviking/README.md 的同步与裁剪方式）：
 * - M：本地存在的文件内容与上游不同；
 * - D：本地存在的文件在上游已删除/移动；
 * - A：上游新增、且不在「已知裁剪范围」的文件（新 host、新共享模块等需要重新裁剪决策的信号）。
 * - 已知裁剪范围（有意不拷贝，不计入漂移）：非 zcode host（cursor/trae/kimicode*）、上游
 *   README/DESIGN、plugin 测试、*.d.mts 与 lib/setup-wizard.mjs（MANIFEST 外散件）、
 *   memory-plugin-shared 下除 lib/ 外的内容、agent-hook-plugin 顶层非 vendored 清单文件。
 * - LICENSE 变化永远不豁免（许可快照必须跟随）。
 *
 * 退出码：0 = 无漂移；1 = 有漂移（详情进 stdout 与 $GITHUB_STEP_SUMMARY）。
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = "volcengine";
const REPO = "OpenViking";
const COMPONENT_ID = "openviking-client-integration";
const UPSTREAM_BASE = "examples";
const VENDOR_ROOT = "vendor/openviking";
const LOCAL_BASELINE = "third-party/copied-components.json";

const VENDOR_TO_UPSTREAM = [
  { local: `${VENDOR_ROOT}/zcode`, upstream: "examples/agent-hook-plugin" },
  { local: `${VENDOR_ROOT}/memory-plugin-shared/lib`, upstream: "examples/memory-plugin-shared/lib" },
];

/** 上游有意不拷贝的内容：新增/删除不计入漂移。LICENSE 永不豁免。 */
function isTrimmed(upstreamPath) {
  if (upstreamPath.endsWith("LICENSE") || upstreamPath.endsWith("LICENSE.txt")) return false;
  if (upstreamPath.endsWith(".d.mts")) return true;
  if (upstreamPath === "examples/memory-plugin-shared/lib/setup-wizard.mjs") return true;
  if (upstreamPath.startsWith("examples/memory-plugin-shared/") &&
      !upstreamPath.startsWith("examples/memory-plugin-shared/lib/")) return true;
  for (const host of ["hosts/cursor", "hosts/trae", "hosts/kimicode", "hosts/cursor.mjs", "hosts/cursor-transcript.mjs", "hosts/trae.mjs", "hosts/trae-turns.mjs", "hosts/kimicode.mjs", "hosts/kimicode-turns.mjs"]) {
    if (upstreamPath.startsWith(`examples/agent-hook-plugin/${host}`)) return true;
  }
  for (const top of ["tests/", "DESIGN.md", "README.md", "README_CN.md"]) {
    if (upstreamPath === `examples/agent-hook-plugin/${top}` ||
        upstreamPath.startsWith(`examples/agent-hook-plugin/${top}`)) return true;
  }
  return false;
}

const token = process.env.GITHUB_TOKEN ?? "";
async function ghApi(path) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status}: ${await resp.text().then((t) => t.slice(0, 300))}`);
  }
  return resp.json();
}

/** git blob sha1（与 GitHub trees API 同算法），免下载内容即可精确比对。 */
function gitBlobSha(content) {
  const hash = createHash("sha1");
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest("hex");
}

async function latestReleaseTagSha() {
  const release = await ghApi(`/repos/${OWNER}/${REPO}/releases/latest`);
  const tagName = release.tag_name;
  const ref = await ghApi(`/repos/${OWNER}/${REPO}/git/ref/tags/${tagName}`);
  let sha = ref.object.sha;
  if (ref.object.type === "tag") {
    const tagObj = await ghApi(`/repos/${OWNER}/${REPO}/git/tags/${sha}`);
    sha = tagObj.object.sha;
  }
  return { tagName, sha, url: release.html_url };
}

async function upstreamTree(sha) {
  const tree = await ghApi(`/repos/${OWNER}/${REPO}/git/trees/${sha}?recursive=1`);
  const map = new Map();
  for (const entry of tree.tree ?? []) {
    if (entry.type !== "blob") continue;
    if (!entry.path.startsWith(`${UPSTREAM_BASE}/agent-hook-plugin/`) &&
        !entry.path.startsWith(`${UPSTREAM_BASE}/memory-plugin-shared/`)) {
      continue;
    }
    map.set(entry.path, entry.sha);
  }
  return map;
}

function localBlobMap() {
  const map = new Map();
  for (const { local, upstream } of VENDOR_TO_UPSTREAM) {
    walkRel(local, upstream, map);
  }
  return map;
}

/** 以相对路径递归遍历，避免 Windows/POSIX 分隔符与前缀截断的错位。 */
function walkRel(localDir, upstreamPrefix, map) {
  const abs = join(process.cwd(), localDir);
  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const rel = `${localDir}/${dirent.name}`;
    const absPath = join(abs, dirent.name);
    if (dirent.isDirectory()) {
      walkRel(rel, upstreamPrefix, map);
    } else if (dirent.isFile()) {
      // rel 去掉 local 目录段后即上游相对路径（zcode/ ↔ agent-hook-plugin、lib/ ↔ lib/）。
      map.set(rel, {
        blob: gitBlobSha(readFileSync(absPath)),
        upstreamPath: `${upstreamPrefix}/${rel.slice(localDir.length + 1)}`,
      });
    }
  }
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}

async function main() {
  const baselineDoc = JSON.parse(readFileSync(LOCAL_BASELINE, "utf-8"));
  const components = Array.isArray(baselineDoc) ? baselineDoc : baselineDoc.components;
  const component = components.find((entry) => entry.id === COMPONENT_ID);
  if (!component) throw new Error(`copied-components.json 缺少 ${COMPONENT_ID}`);
  const baselineRevision = component.referenceRevision;
  console.log(`vendored baseline revision: ${baselineRevision}`);

  const { tagName, sha: latestSha, url } = await latestReleaseTagSha();
  console.log(`upstream latest release: ${tagName} (${latestSha}) -> ${url}`);
  if (latestSha === baselineRevision) {
    const ok = `✅ 上游 latest release ${tagName} 即 vendored 基线，无需同步。`;
    console.log(ok);
    appendSummary(ok);
    return;
  }

  const upstream = await upstreamTree(latestSha);
  const local = localBlobMap();

  const drift = [];
  for (const [rel, { blob, upstreamPath }] of local) {
    const upstreamBlob = upstream.get(upstreamPath);
    if (upstreamBlob === undefined) {
      drift.push({ type: "D", path: upstreamPath });
    } else if (upstreamBlob !== blob) {
      drift.push({ type: "M", path: upstreamPath });
    }
  }
  const localByUpstream = new Set([...local.values()].map((v) => v.upstreamPath));
  for (const path of upstream.keys()) {
    if (isTrimmed(path)) continue;
    if (!localByUpstream.has(path)) {
      drift.push({ type: "A", path });
    }
  }

  if (drift.length === 0) {
    const ok = `✅ 无漂移：vendor/openviking 的 vendored 文件与上游 ${tagName} 一致（基线 ${baselineRevision.slice(0, 9)}，上游有非 vendored 内容变化属正常）。`;
    console.log(ok);
    appendSummary(ok);
    return;
  }

  const order = { M: 0, A: 1, D: 2 };
  drift.sort((a, b) => order[a.type] - order[b.type] || a.path.localeCompare(b.path));
  const badge = { M: "M", A: "A", D: "D" };
  const summary = [
    `⚠️ vendor/openviking 相对上游 [${tagName}](${url}) 存在漂移（vendored 基线 ${baselineRevision.slice(0, 9)}）：`,
    "",
    ...drift.map((entry) => `  ${badge[entry.type]} ${entry.path}`),
    "",
    "M=内容变化 A=上游新增（需裁剪决策） D=上游删除。同步方式见 vendor/openviking/README.md；",
    "同步后更新 third-party/copied-components.json 的 referenceRevision。",
  ].join("\n");
  console.log(summary);
  appendSummary(summary);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
