// ============================================================
// Vision Bridge Port - fallback 视觉模型桥接的执行边界
// ============================================================
// 存在的理由：core runtime 负责判定「该不该桥接」与「桥接后消息怎么变换」，
// 但看不见 provider 注册表，也不该依赖 adapters 的网络装配。端口把
// 「一张图换一段文字」这件宿主事实递进来，实现在 bootstrap（经 Provider
// Registry 解析 fallback provider 的连接事实 + adapters 桥接请求模块）。
//
// 结果是可辨识联合而不是 Promise 抛错：单图桥接失败必须能被编排层逐张降级
// （替换占位、turn 继续），抛错会让「失败原因」和「失败这一事实」混在一起。

/** 单图桥接请求。图片只以 data URL 传递，端口实现不落盘。 */
export interface VisionBridgeImageRequest {
  imageDataUrl: string;
  mediaType: string;
  modelId: string;
  providerId: string;
}

export type VisionBridgeImageResult =
  | { readonly ok: true; readonly description: string }
  | { readonly ok: false; readonly reason: string };

export interface VisionBridgePort {
  /** 用 fallback 视觉模型描述一张图片；失败以 ok:false 返回，不抛错。 */
  describeImage(request: VisionBridgeImageRequest): Promise<VisionBridgeImageResult>;
}
