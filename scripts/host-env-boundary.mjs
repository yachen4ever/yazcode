// 宿主环境注入面边界原语的 node 形态（scripts 侧入口）。
// 语义事实源在 packages/shared/src/hostEnvBoundary.ts（TS 纯函数）——此处经 tsx 的
// CJS require 钩子加载同一实现，不复制语义；spec：docs/specs/host-env-injection-boundary.md。
//
// 同步实现的原因：构建链的若干消费点（build-metadata 的 collectBuildMetadata、
// tsup/vite 配置顶层）本身是同步函数，无法 await 异步加载。
//
// 加载失败时的降级口径：宁可不过滤（保持既有行为并让构建继续），也不引入「静默
// 全量删除 ZCODE_*」的次生故障；但过滤失败必须是可见的（打印告警）。
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
let cached = null;

function loadBoundary() {
  if (cached) return cached;
  try {
    require("tsx/cjs");
    cached = require(resolve(import.meta.dirname, "../packages/shared/src/hostEnvBoundary.ts"));
  } catch (error) {
    console.warn(
      `[host-env-boundary] 宿主注入变量剥离原语加载失败（保持环境不变）: ${String(error)}`,
    );
    cached = null;
  }
  return cached;
}

/**
 * CI 发布链是否可信发布注入集（release.yml 的四个变量）。
 * 本地构建不信任——宿主可能注入同名旧版本号（mint 双盲 F1 的版本烤入事故）。
 */
export function isPublishInjectionTrusted() {
  return Boolean(process.env.CI);
}

/**
 * 就地剥离宿主注入变量（deny-by-default）。加载失败时告警并保持环境不变。
 * @param {Record<string, string | undefined>} env
 * @param {{allowPublishInjection?: boolean, extraAllowlist?: readonly string[]}} [options]
 */
export function stripHostInjectedEnvInPlace(env = process.env, options = {}) {
  const boundary = loadBoundary();
  if (!boundary) return;
  boundary.stripHostInjectedEnvInPlace(env, {
    allowPublishInjection: options.allowPublishInjection ?? isPublishInjectionTrusted(),
    ...(options.allowDevRuntimeKeys === undefined
      ? {}
      : { allowDevRuntimeKeys: options.allowDevRuntimeKeys }),
    ...(options.extraAllowlist ? { extraAllowlist: options.extraAllowlist } : {}),
  });
}

/**
 * 返回剥离后的新 env 对象（不改入参）。
 * @param {Record<string, string | undefined>} env
 */
export function stripHostInjectedEnv(env, options = {}) {
  const boundary = loadBoundary();
  if (!boundary) return { ...env };
  return boundary.stripHostInjectedEnv(env, {
    allowPublishInjection: options.allowPublishInjection ?? isPublishInjectionTrusted(),
    ...(options.allowDevRuntimeKeys === undefined
      ? {}
      : { allowDevRuntimeKeys: options.allowDevRuntimeKeys }),
    ...(options.extraAllowlist ? { extraAllowlist: options.extraAllowlist } : {}),
  });
}
