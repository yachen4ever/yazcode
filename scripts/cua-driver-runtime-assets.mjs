// CUA 原生运行时资产暂存：把 `@trycua/cua-driver`（SDK JS + 平台原生库）拷进
// node-repl-host 的 `dist/mcp/node_modules`，使打包后的 node_repl server 能按标准
// Node 解析规则 `import("@trycua/cua-driver")` 加载真实现（见 zcode-cua/platform.js）。
//
// 来源：axiom-desu/ZCodium@main 的 scripts/cua-driver-runtime-assets.mjs（Apache-2.0）。
// YazCode 移植差异：
// - 不依赖 `@zcode/shared/builtin-plugin-assets`，常量内联（本仓库 bootstrap 未引入该模块）；
// - `third-party/cua-driver/NOTICE.md` 在本仓库不存在（红线：不改 third-party/），
//   该 NOTICE 存在时才拷贝为 dist/mcp/CUA-NOTICES.md；@trycua/cua-driver 为 MIT，
//   其 LICENSE 随包目录本身一起拷贝，署名义务仍然满足。

import { cp, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** node_repl 宿主内为 CUA 运行时保留的依赖子树（bootstrap seed 的 runtimeSubtrees 同值）。 */
export const CUA_RUNTIME_MODULES_PATH = "dist/mcp/node_modules";

/** 目标平台对应的 cua-driver 原生包名（与 @trycua/cua-driver 的 optionalDependencies 对齐）。 */
export function cuaNativePackage(platform, arch) {
  if (!["linux", "win32", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported CUA target: ${platform}-${arch}`);
  }
  const suffix = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  return `@trycua/cua-driver-${platform}-${arch}${suffix}`;
}

/**
 * 暂存产物必须齐备的文件清单。seed 侧（bootstrap/official-plugin-definitions.ts）用同一份
 * 逻辑做首启校验；两边必须同步维护。
 */
export function cuaRuntimeRequiredPaths(platform, arch) {
  const native = cuaNativePackage(platform, arch);
  const library =
    platform === "win32"
      ? "cua_driver_sdk.dll"
      : platform === "darwin"
        ? "libcua_driver_sdk.dylib"
        : "libcua_driver_sdk.so";
  return [
    "@trycua/cua-driver/package.json",
    "@trycua/cua-driver/dist/index.js",
    "@trycua/cua-driver/dist/native/node-runtime.js",
    "@ubjs/core/package.json",
    "@ubjs/core/dist/esm/index.js",
    "@ubjs/node/package.json",
    "@ubjs/node/typescript/dist/resolve-lib.js",
    `${native}/package.json`,
    `${native}/${library}`,
    `${native}/cua_driver_node_runtime.node`,
    `${native}/node-runtime-NOTICE.md`,
  ].map((path) => `${CUA_RUNTIME_MODULES_PATH}/${path}`);
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** 构建期专用：保持 SDK 的原生 loader 与标准 npm 解析，不做任何打包内联。 */
export async function stageCuaDriverRuntime(pluginRoot, options = {}) {
  await stageCuaDriverRuntimeFiles(join(pluginRoot, dirname(CUA_RUNTIME_MODULES_PATH)), options);
}

export async function stageCuaDriverRuntimeFiles(
  mcpDirectory,
  {
    platform = process.platform,
    arch = process.arch,
    sourceModules = join(repositoryRoot, "node_modules"),
  } = {},
) {
  const native = cuaNativePackage(platform, arch);
  const expected = (await readJson(join(repositoryRoot, "packages/zcode-cua/package.json")))
    .dependencies["@trycua/cua-driver"];
  const sdk = await readJson(join(sourceModules, "@trycua/cua-driver/package.json"));
  const packages = new Map([
    ["@trycua/cua-driver", expected],
    [native, expected],
    ["@ubjs/core", sdk.dependencies["@ubjs/core"]],
    ["@ubjs/node", sdk.dependencies["@ubjs/node"]],
  ]);
  // 构建期守卫：SDK 与原生包版本错配时立即失败，禁止靠开发目录的旧依赖兜底
  //（原 bundle 内联 SDK 后丢失原生包定位，正是这类漂移的事故来源）。
  for (const [name, version] of packages) {
    const manifest = await readJson(join(sourceModules, name, "package.json"));
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`CUA runtime version mismatch: ${name}, expected ${version}`);
    }
  }
  const modules = join(mcpDirectory, "node_modules");
  // 交叉打包必须清理上一个目标的原生库，不能把构建机平台带入安装包。
  await rm(modules, { recursive: true, force: true });
  for (const name of packages.keys()) {
    const source = join(sourceModules, name);
    await cp(source, join(modules, name), {
      recursive: true,
      dereference: true,
      filter: (path) => path === source || basename(path) !== "node_modules",
    });
  }
  // third-party/cua-driver/NOTICE.md 仅在仓库存在时拷贝（见文件头说明）。
  const noticeSource = join(repositoryRoot, "third-party/cua-driver/NOTICE.md");
  await cp(noticeSource, join(mcpDirectory, "CUA-NOTICES.md"), { force: true }).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await validateCuaDriverRuntimeFiles(mcpDirectory, { platform, arch });
}

export async function validateCuaDriverRuntime(pluginRoot, target) {
  await validateCuaDriverRuntimeFiles(join(pluginRoot, dirname(CUA_RUNTIME_MODULES_PATH)), target);
}

async function validateCuaDriverRuntimeFiles(mcpDirectory, { platform, arch }) {
  for (const path of cuaRuntimeRequiredPaths(platform, arch)) {
    const entry = await stat(
      join(mcpDirectory, relative(dirname(CUA_RUNTIME_MODULES_PATH), path)),
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry?.isFile() || !entry.size) throw new Error(`Missing CUA runtime asset: ${path}`);
  }
}
