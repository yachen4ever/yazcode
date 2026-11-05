import { app } from "electron";
import { join } from "node:path";
import { resolveZCodeBuiltinProviderConfigFilePath as resolveWithDefaults } from "./desktopProviderConfigPaths.js";

export function resolveZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  return resolveWithDefaults({
    appPath: options?.appPath ?? app.getAppPath(),
    env: options?.env ?? process.env,
    isPackaged: options?.isPackaged ?? app.isPackaged,
    resourcesPath: options?.resourcesPath ?? process.resourcesPath,
  });
}
