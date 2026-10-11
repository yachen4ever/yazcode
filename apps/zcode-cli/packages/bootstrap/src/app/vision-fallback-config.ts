import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visionFallbackSettingsSchema, type VisionFallbackSettings } from "@zcode/shared";

/**
 * 视觉桥接设置的 CLI 侧容错读取。
 *
 * 设置事实的唯一写入方是 Host SettingService（~/.yazcode/v2/setting.json）；
 * 协议未提供 app settings 下发通道（本能力刻意不改 zcode-protocol），CLI 进程在
 * App 创建时直接容错读取同一份文件并冻结进 runtime 配置。读取/解析/校验任何一步
 * 失败都按「未配置」处理，绝不影响启动。设置变更对之后创建的 session 生效。
 */

function resolveAppSettingsFilePath(env: Readonly<Record<string, string | undefined>>): string | undefined {
  // 与 SettingService 的 home 解析保持同一优先级，dev 数据目录隔离才能读到同一份设置。
  const home =
    env.ZCODE_DESKTOP_HOME_DIR?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim();
  return home && home.length > 0 ? join(home, ".yazcode", "v2", "setting.json") : undefined;
}

export function readVisionFallbackSettings(
  env: Readonly<Record<string, string | undefined>>,
): VisionFallbackSettings | undefined {
  const settingsFile = resolveAppSettingsFilePath(env);
  if (!settingsFile) return undefined;
  try {
    // 只校验 visionFallback 子树，不整份 parse：设置文件里其他字段的损坏
    // 不应连累视觉桥接的可用性，反之亦然。
    const raw = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
    if (!raw.visionFallback || typeof raw.visionFallback !== "object") {
      return undefined;
    }
    const parsed = visionFallbackSettingsSchema.safeParse(raw.visionFallback);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 「无视觉」缓存文件路径：cliStorageRoot 下独立目录，由 core 拥有读写。 */
export function resolveVisionFallbackCacheFilePath(cliStorageRoot: string): string {
  return join(cliStorageRoot, "vision-fallback", "no-vision-models.json");
}
