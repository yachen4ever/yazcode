import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHostInjectedEnvInPlace } from "../../../scripts/host-env-boundary.mjs";

const require = createRequire(import.meta.url);
const moduleDir = import.meta.dirname;

function findPackageDir(packageName, startDirs) {
  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = readJson(packageJsonPath);
          if (packageJson.name === packageName) {
            return currentDir;
          }
        } catch {
          // ignore invalid package.json and continue walking up
        }
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(`Unable to find package directory for ${packageName}`);
}

const desktopDir = findPackageDir("@zcode/desktop", [
  moduleDir,
  resolve(moduleDir, ".."),
  process.cwd(),
]);
const workspaceDir = resolve(desktopDir, "../..");
const metadataDir = resolve(desktopDir, "out/metadata");
const metadataPath = resolve(metadataDir, "build-meta.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

function resolveInstalledPackageVersion(packageName, fallbackVersion) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [desktopDir] });
    return normalizeVersion(readJson(packageJsonPath).version);
  } catch {
    return normalizeVersion(fallbackVersion);
  }
}

function resolveCommitId() {
  try {
    return execSync("git rev-parse --short=8 HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return process.env.ZCODE_COMMIT ?? "unknown";
  }
}

export function collectBuildMetadata() {
  // 宿主注入面剥离（deny-by-default，spec：docs/specs/host-env-injection-boundary.md）：
  // 宿主 ZCode 注入的 ZCODE_/YAZCODE_/ZCODIUM_ 变量随继承环境污染构建，
  // ZCODE_APP_VERSION 已发「版本元数据烤入宿主版本号」事故——本地构建必须回退
  // package.json 版本；ZCODE_COMMIT 同前缀一并剥离（宿主注入的 commit 同样不可信）。
  // CI 发布链的白名单（release.yml 注入的 ZCODE_APP_VERSION 等）由原语按
  // allowPublishInjection 保留——不再靠「CI 下整体不洗」这种粗粒度豁免。
  // 常规桌面构建管线中本脚本以 prepare:build-meta 独立进程先于
  // tsup/vite/electron-builder 执行，此处的剥离不波及后续构建进程；若
  // build-meta.json 缺席而由 vite/tsup 配置内联触发 collect，剥离同样让宿主注入值
  // 不进构建，方向一致。
  stripHostInjectedEnvInPlace(process.env);
  const rootPackageJson = readJson(resolve(workspaceDir, "package.json"));
  const desktopPackageJson = readJson(resolve(desktopDir, "package.json"));

  return {
    // CI 发布时把完整 tag 版本（如 3.14.0-audit.20260922.6）通过 ZCODE_APP_VERSION 注入，
    // 安装包文件名与应用版本都会带上审计序号；本地构建回退到 package.json 版本。
    appVersion: normalizeVersion(process.env.ZCODE_APP_VERSION?.trim() || rootPackageJson.version),
    buildCommitId: resolveCommitId(),
    buildTime: new Date().toISOString(),
    electronBuilderVersion: resolveInstalledPackageVersion(
      "electron-builder",
      desktopPackageJson.devDependencies?.["electron-builder"],
    ),
  };
}

export function readBuildMetadata() {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return readJson(metadataPath);
  } catch {
    return null;
  }
}

export function getBuildMetadata() {
  return readBuildMetadata() ?? collectBuildMetadata();
}

export function writeBuildMetadata() {
  // About 之前分别在 tsup、vite 里各算一份 commit 和时间。
  // 问题原因：两次构建是独立进程，时间点天然不一致；后面再打包时，最终安装包里展示的信息也不一定对应同一次产物。
  // 这里先统一落盘成 build-meta.json，再让构建和运行时都复用同一份数据，保证 about 可追溯。
  const metadata = collectBuildMetadata();
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadata;
}

export function getBuildMetadataPath() {
  return metadataPath;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entryFilePath === currentFilePath) {
  const metadata = writeBuildMetadata();
  process.stdout.write(`[build-meta] wrote ${metadataPath}\n`);
  process.stdout.write(
    `[build-meta] commit=${metadata.buildCommitId} time=${metadata.buildTime}\n`,
  );
}
