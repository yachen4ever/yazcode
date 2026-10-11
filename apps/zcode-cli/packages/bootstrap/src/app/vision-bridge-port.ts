import type { VisionBridgeImageRequest, VisionBridgePort } from "@zcode/contracts";
import { requestVisionBridgeDescription } from "@zcode/adapters/model";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

/**
 * 视觉桥接端口实现：把 core 的「一张图换一段文字」请求落到 Provider Registry 的
 * 真实连接事实上。fallback provider 的 baseUrl/apiKey/TLS 选项在每次调用时现读
 * Registry 活视图，与正式模型执行链同源——用户改配置后无需重建 runtime 端口。
 */
export function createVisionBridgePort(input: {
  env: Readonly<Record<string, string | undefined>>;
  registry: ProviderRegistryModelSource;
  fetch?: typeof globalThis.fetch;
}): VisionBridgePort {
  return {
    async describeImage(request: VisionBridgeImageRequest) {
      const provider = input.registry.getProvider(request.providerId);
      if (!provider) {
        return { ok: false as const, reason: `Provider 不存在: ${request.providerId}` };
      }
      const access = provider.config.access;
      const apiKey = access.type !== "zhipu-account" ? access.apiKey : undefined;
      try {
        const description = await requestVisionBridgeDescription({
          ...(provider.config.api.allowInsecureTls ? { allowInsecureTls: true } : {}),
          ...(apiKey ? { apiKey } : {}),
          baseUrl: provider.config.api.baseUrl,
          env: { ...input.env },
          ...(input.fetch ? { fetch: input.fetch } : {}),
          imageDataUrl: request.imageDataUrl,
          modelId: request.modelId,
          ...(provider.config.api.tlsCaPath ? { tlsCaPath: provider.config.api.tlsCaPath } : {}),
        });
        return { description, ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
