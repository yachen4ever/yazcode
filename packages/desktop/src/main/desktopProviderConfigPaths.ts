/**
 * ZCode builtin 配置路径解析纯函数（electron-free，可直测）。
 * 门禁语义与事实源契约见 docs/specs/builtin-provider-config-packaging.md：
 * 打包态单一事实源 = 包内 resources/config/provider/zcode-builtin.json，
 * env 显式路径仅 dev 态生效（R2：宿主会话启动打包应用时 env 被宿主注入污染，
 * 曾绕过 extraResources 锁源导致 Bundled/Active 双炸）。
 */
import { join } from "node:path";

export function resolveZCodeBuiltinProviderConfigFilePath(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly appPath?: string;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = options.isPackaged
    ? undefined
    : options.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) return explicitPath;
  if (options.isPackaged) {
    return join(options.resourcesPath ?? "", "config/provider/zcode-builtin.json");
  }
  // 开发态与打包共用唯一线上配置源。
  const filename = "zcode-builtin.json";
  return join(options.appPath ?? "", "../../config/provider", filename);
}
