import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { isPublishInjectionTrusted, stripHostInjectedEnv } from "./host-env-boundary.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * 剔除宿主注入的 builtin 配置源环境变量。
 *
 * 历史：R1 曾以「点名 ZCODE_BUILTIN_PROVIDER / YAZCODE_BUILTIN_PROVIDER 前缀」实现
 * （开放集合上的补丁），R2 收敛到统一原语——本函数保留为薄包装以兼容既有调用方，
 * 语义事实源在 packages/shared/src/hostEnvBoundary.ts（deny-by-default 全前缀
 * 剥离 + 白名单，spec：docs/specs/host-env-injection-boundary.md）。
 *
 * @param {Record<string, string | undefined>} env 待清洗的环境（默认 process.env 的浅拷贝）
 * @param {{allowPublishInjection?: boolean, ciContext?: boolean}} [options] 发布注入集是否可信（CI 发布链）
 * @returns {Record<string, string | undefined>} 剔除宿主注入变量后的新对象，不改原对象
 */
export function stripHostInjectedBuiltinProviderEnv(env = process.env, options = {}) {
  return stripHostInjectedEnv(env, {
    allowPublishInjection:
      options.allowPublishInjection ?? isPublishInjectionTrusted(options.ciContext),
    ...(options.allowDevRuntimeKeys === undefined
      ? {}
      : { allowDevRuntimeKeys: options.allowDevRuntimeKeys }),
  });
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

/** @param {{root?: string, env?: Record<string, string | undefined>, ciContext?: boolean}} options */
export async function loadBuiltinProviderConfig({
  root = repositoryRoot,
  env = process.env,
  ciContext,
} = {}) {
  // 宿主注入面剥离（deny-by-default，spec：docs/specs/host-env-injection-boundary.md）：
  // y430p 本机实证——zcode 宿主会话内构建时 prepare-prebuilds/SEA 等链路经本函数
  // 直吃 process.env 的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（GLM runtime 副本），
  // 构建即炸 Invalid Built-in Provider config。剔除在事实源读取前统一执行，
  // 覆盖所有消费链，不再依赖各链自行清洗；.env 显式覆盖（loadEndpointEnv 合并）
  // 不受影响。对显式传入的 env 同样幂等生效。
  // ciContext：语境显式参数（26.5.4 增补批 ②）；缺省回落 process.env.CI，
  // 生产调用点行为不变，测试显式传参不再操作环境。
  env = stripHostInjectedEnv(env, {
    allowPublishInjection: isPublishInjectionTrusted(ciContext),
  });
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
