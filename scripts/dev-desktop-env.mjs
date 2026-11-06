import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";
import { stripHostInjectedEnvInPlace } from "./host-env-boundary.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const agentBytecode = process.argv.slice(3).includes("--agent-bytecode");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error("Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode]");
  process.exit(1);
}

// dev 实例的数据目录隔离不能只依赖 mise 任务层注入：绕过 mise 直接运行
// pnpm dev:desktop:test 时若没有 ZCODE_DATA_BASE_DIR，实例会读写开发者真实的
// ~/.zcode（曾因此重写真实 credentials.json）。test 模式在此兜底注入与 mise
// 任务一致的默认隔离目录；production 保持 dogfood 语义不注入。
const DEFAULT_ISOLATED_DATA_BASE_DIR = join(homedir(), ".zcode-dev-home");
const legacyDataBaseDirSet =
  process.env.YAZCODE_DATA_BASE_DIR?.trim() || process.env.ZCODE_DATA_BASE_DIR?.trim();
if (requestedEnv === "test" && !legacyDataBaseDirSet) {
  // 新旧名双写：新旧二进制混布（SSH 远端旧 agent）也能读到隔离目录。
  process.env.YAZCODE_DATA_BASE_DIR = DEFAULT_ISOLATED_DATA_BASE_DIR;
  process.env.ZCODE_DATA_BASE_DIR = DEFAULT_ISOLATED_DATA_BASE_DIR;
}
// 宿主注入面剥离（deny-by-default，spec：docs/specs/host-env-injection-boundary.md）：
// 剔除宿主 CLI 泄漏的 builtin 配置路径等注入变量——原实现只点名删两个旧名键，
// 漏掉改名后的新名（YAZCODE_BUILTIN_PROVIDER_*）与 ZCODIUM_ legacy 名。dev 启动
// 脚本是三者中防护最弱的一处，现统一到原语。dev 通道集（数据目录/桌面隔离/
// E2E 等）保留——它们是开发者显式配置，不是宿主注入。
stripHostInjectedEnvInPlace(process.env);
console.log(
  `[dev] ZCODE_ENV=${requestedEnv} 数据目录: ${
    process.env.ZCODE_DATA_BASE_DIR?.trim() || "(未注入 — 将使用真实 HOME，dogfood 模式)"
  }`,
);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// mise 的 Windows shim 是 pnpm.exe（fnm/corepack 时代是 pnpm.cmd）；
// shell:true 下按 PATHEXT 解析，统一用 "pnpm" 两种 shim 都能命中。
const pnpmCommand = "pnpm";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    // Windows 下 shell:true 只按空格拼接参数；仓库路径含空格（如 E:\Z Code\...）时
    // node <script> 的脚本路径会被 cmd 截断成 E:\Z 并报 Cannot find module，因此先补引号。
    const spawnArgs = process.platform === "win32" ? quoteArgsForWindowsShell(args) : args;
    const child = spawn(command, spawnArgs, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...process.env,
          ZCODE_ENV: requestedEnv,
          ZCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
        },
        process.execPath,
      ),
      stdio: "inherit",
      // Windows .cmd/.bat executables (pnpm.cmd, npm.cmd, etc.) require shell: true
      shell: process.platform === "win32",
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "pre-dev"]);
  // On Windows, use "node" (resolved via PATHEXT) to avoid "C:\Program Files\..." space issues
  await run(process.platform === "win32" ? "node" : process.execPath, [
    resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"),
  ]);
  if (agentBytecode) {
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs"),
    ]);
  }
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
