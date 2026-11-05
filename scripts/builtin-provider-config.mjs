import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * 剔除宿主 CLI 注入的 builtin 配置源环境变量（新旧前缀全量点名）。
 *
 * 在 ZCode 宿主会话内构建时，宿主运行时会向子进程注入
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE / YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE（及
 * _BUNDLED_CONFIG_FILE 变体）指向宿主 runtime 数据副本，其 schema 可能比仓库解析器
 * 新。构建链若直接继承该环境，staging / extraResources 会静默改用宿主副本，打出
 * 「宿主 schema 内容 + 仓库旧解析器」的包，运行时解码 ZodError，表现为
 * 「Bundled 与 Active ZCode Built-in Release 均不可用」（mint 双盲 F1，
 * spec 见 docs/specs/builtin-provider-config-packaging.md）。
 *
 * 与 scripts/build-desktop-agent-cli.mjs 的前缀口径一致：点名
 * ZCODE_BUILTIN_PROVIDER / YAZCODE_BUILTIN_PROVIDER 前缀（开放集合整体剔除，不做
 * 点名单删补丁），不触碰 release.yml 合法注入的 ZCODE_APP_VERSION / ZCODE_ENV。
 * 开发者经 .env 文件的显式覆盖走 loadEndpointEnv 合并，不受本函数影响。
 *
 * @param {Record<string, string | undefined>} env 待清洗的环境（默认 process.env 的浅拷贝）
 * @returns {Record<string, string | undefined>} 剔除宿主注入变量后的新对象，不改原对象
 */
export function stripHostInjectedBuiltinProviderEnv(env = process.env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith("ZCODE_BUILTIN_PROVIDER") || key.startsWith("YAZCODE_BUILTIN_PROVIDER")) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const sourcePath = resolve(
    root,
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "config/provider/zcode-builtin.json",
  );
  try {
    const content = await readFile(sourcePath, "utf8");
    // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
    // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
    // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
    const { decodeZCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeZCodeBuiltinRelease(JSON.parse(content));
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
