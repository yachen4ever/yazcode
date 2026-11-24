#!/usr/bin/env node
/**
 * vendor/openviking 上游漂移检测（走 GitHub trees API 的 blob sha 比对，不下载文件内容）。
 *
 * 数据源：
 * - 同步基线：third-party/copied-components.json 的 openviking-client-integration.referenceRevision
 *   （同时作为祖先校验锚：必须位于上游 main 历史中，防任意 pin/伪造分支）。
 * - 比对基准（26.5.11 适配，issue #43）：在「latest release」与「上游 main HEAD」之间，
 *   取 integration 版本与本地 vendored integration.json 版本**一致**者优先（release 优先）；
 *   两者都不一致（上游已前进到更新版本）→ 回退 latest release 并正常报告漂移（「上游有新版本」信号保留），
 *   不得因版本不一致而放宽为永久绿。
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
import { pathToFileURL } from "node:url";

const OWNER = "volcengine";
const REPO = "OpenViking";
const COMPONENT_ID = "openviking-client-integration";
const UPSTREAM_BASE = "examples";
const VENDOR_ROOT = "vendor/openviking";
const LOCAL_BASELINE = "third-party/copied-components.json";

const VENDOR_TO_UPSTREAM = [
  { local: `${VENDOR_ROOT}/zcode`, upstream: "examples/agent-hook-plugin" },
  {
    local: `${VENDOR_ROOT}/memory-plugin-shared/lib`,
    upstream: "examples/memory-plugin-shared/lib",
  },
];

/** 上游有意不拷贝的内容：新增/删除不计入漂移。LICENSE 永不豁免。 */
export function isTrimmed(upstreamPath) {
  if (upstreamPath.endsWith("LICENSE") || upstreamPath.endsWith("LICENSE.txt")) return false;
  if (upstreamPath.endsWith(".d.mts")) return true;
  if (upstreamPath === "examples/memory-plugin-shared/lib/setup-wizard.mjs") return true;
  if (
    upstreamPath.startsWith("examples/memory-plugin-shared/") &&
    !upstreamPath.startsWith("examples/memory-plugin-shared/lib/")
  )
    return true;
  for (const host of [
    "hosts/cursor",
    "hosts/trae",
    "hosts/kimicode",
    "hosts/antigravity",
    "hosts/qoder",
    "hosts/cursor.mjs",
    "hosts/cursor-transcript.mjs",
    "hosts/trae.mjs",
    "hosts/trae-turns.mjs",
    "hosts/kimicode.mjs",
    "hosts/kimicode-turns.mjs",
    "hosts/antigravity.mjs",
    "hosts/qoder.mjs",
    "hosts/qoder-turns.mjs",
  ]) {
    if (upstreamPath.startsWith(`examples/agent-hook-plugin/${host}`)) return true;
  }
  for (const top of ["tests/", "DESIGN.md", "README.md", "README_CN.md"]) {
    if (
      upstreamPath === `examples/agent-hook-plugin/${top}` ||
      upstreamPath.startsWith(`examples/agent-hook-plugin/${top}`)
    )
      return true;
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
export function gitBlobSha(content) {
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

async function mainHeadSha() {
  const ref = await ghApi(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  return ref.object?.sha;
}

/** 读指定 revision 的上游 integration 版本（小文件，单请求）。 */
async function upstreamIntegrationVersion(sha) {
  try {
    const file = await ghApi(
      `/repos/${OWNER}/${REPO}/contents/${UPSTREAM_BASE}/agent-hook-plugin/hosts/zcode/openviking.integration.json?ref=${sha}`,
    );
    const parsed = JSON.parse(Buffer.from(file.content ?? "", "base64").toString("utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 本地 vendored integration 版本（比对基准选择的依据）。 */
export function readLocalIntegrationVersion() {
  const file = join(process.cwd(), VENDOR_ROOT, "zcode/hosts/zcode/openviking.integration.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`vendored integration.json 缺少 version: ${file}`);
  }
  return parsed.version.trim();
}

/**
 * 比对基准选择（纯函数，测试直测；issue #43 决策 b）：
 * - candidates.release / candidates.main 各自带 integration 版本；
 * - 与 localIntegrationVersion 一致者优先（release 优先——「跟随 release」语义不变）；
 * - 均不一致 → 回退 release 并标记 upstreamAhead（上游已前进，正常报告漂移）；
 * - main 版本一致而 release 不一致（main 已 bump 过后 release 未发）→ 选 main，
 *   vendored 同步到 main HEAD 的轮次由此免于误报。
 */
export function pickComparisonTarget({ localIntegrationVersion, release, main }) {
  const matches = (candidate) =>
    candidate && candidate.integrationVersion === localIntegrationVersion;
  if (matches(release)) return { ...release, kind: "release", upstreamAhead: false };
  if (matches(main)) return { ...main, kind: "main", upstreamAhead: false };
  return { ...release, kind: "release", upstreamAhead: true };
}

/** referenceRevision 必须位于上游 main 历史中（防任意 pin 到分支/未知提交）。 */
async function assertBaselineIsAncestorOfMain(baselineRevision) {
  const compare = await ghApi(`/repos/${OWNER}/${REPO}/compare/${baselineRevision}...main`);
  if (compare.status !== "ahead" && compare.status !== "identical") {
    throw new Error(
      `referenceRevision ${baselineRevision.slice(0, 9)} 不在上游 main 历史中（status=${compare.status}）——禁止任意 pin`,
    );
  }
}

async function upstreamTree(sha) {
  const tree = await ghApi(`/repos/${OWNER}/${REPO}/git/trees/${sha}?recursive=1`);
  const map = new Map();
  for (const entry of tree.tree ?? []) {
    if (entry.type !== "blob") continue;
    if (
      !entry.path.startsWith(`${UPSTREAM_BASE}/agent-hook-plugin/`) &&
      !entry.path.startsWith(`${UPSTREAM_BASE}/memory-plugin-shared/`)
    ) {
      continue;
    }
    map.set(entry.path, entry.sha);
  }
  return map;
}

export function localBlobMap() {
  const map = new Map();
  for (const { local, upstream } of VENDOR_TO_UPSTREAM) {
    walkRel(local, upstream, map, local);
  }
  return map;
}

/** 以相对路径递归遍历，避免 Windows/POSIX 分隔符与前缀截断的错位。 */
function walkRel(localDir, upstreamPrefix, map, rootDir) {
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
      walkRel(rel, upstreamPrefix, map, rootDir);
    } else if (dirent.isFile()) {
      // rel 去掉【映射根】目录段后即上游相对路径（zcode/ ↔ agent-hook-plugin、lib/ ↔ lib/）。
      // 修复：此前截取基准是「当前父目录」，递归进 scripts/、hosts/、lib/install/ 等二层及
      // 更深目录时，会把「scripts/hook.mjs」错映射成上游扁平路径「hook.mjs」——上游不存在
      // 这些扁平路径，于是同一批文件同时产生幻影 D（错误映射路径上游缺失）与幻影 A（真实
      // 嵌套路径无本地覆盖），漂移清单远大于真实差异。截取基准必须是映射根，与目录深度无关。
      map.set(rel, {
        blob: gitBlobSha(readFileSync(absPath)),
        upstreamPath: `${upstreamPrefix}/${rel.slice(rootDir.length + 1)}`,
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

  await assertBaselineIsAncestorOfMain(baselineRevision);
  const localIntegrationVersion = readLocalIntegrationVersion();
  const release = await latestReleaseTagSha();
  const mainSha = await mainHeadSha();
  const releaseIntegrationVersion = await upstreamIntegrationVersion(release.sha);
  const mainIntegrationVersion = await upstreamIntegrationVersion(mainSha);
  const target = pickComparisonTarget({
    localIntegrationVersion,
    release: {
      sha: release.sha,
      tagName: release.tagName,
      url: release.url,
      integrationVersion: releaseIntegrationVersion,
    },
    main: {
      sha: mainSha,
      tagName: `main@${mainSha.slice(0, 9)}`,
      url: `https://github.com/${OWNER}/${REPO}/commit/${mainSha}`,
      integrationVersion: mainIntegrationVersion,
    },
  });
  console.log(
    `upstream latest release: ${release.tagName} (${release.sha}, integration ${release.integrationVersion ?? "?"})`,
  );
  console.log(`upstream main HEAD: ${mainSha.slice(0, 9)} (integration ${mainIntegrationVersion ?? "?"})`);
  console.log(
    `comparison target: ${target.kind} ${target.tagName} (${target.sha})——vendored integration ${localIntegrationVersion}${
      target.upstreamAhead ? "；上游已是更新版本，vendored 需跟进" : ""
    }`,
  );
  const { tagName, sha: latestSha, url } = target;
  // 26.5.11 严格化（issue #43）：target==baseline 也做完整内容比对——原快速路径在
  // 「上游仍停在 vendored 基线」时直接绿，不校验 vendored 内容与基线 tree 是否一致，
  // 会让不完整同步/本地误改假绿。现在只有「内容确实与基线一致」才绿。

  const upstream = await upstreamTree(latestSha);
  const local = localBlobMap();

  const drift = [];
  for (const [rel, { blob, upstreamPath }] of local) {
    if (isTrimmed(upstreamPath)) continue;
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
    const ok =
      latestSha === baselineRevision
        ? `✅ 无漂移：上游 ${tagName} 即 vendored 基线（${baselineRevision.slice(0, 9)}），vendored 内容与基线一致。`
        : `✅ 无漂移：vendor/openviking 的 vendored 文件与上游 ${tagName} 一致（基线 ${baselineRevision.slice(0, 9)}，上游有非 vendored 内容变化属正常）。`;
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

// 仅在直接执行时联网比对；被测试导入时只暴露纯函数。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
