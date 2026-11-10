import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 连接校验失败的原因分类；UI 依此给出可诊断提示，不回落到 local 档位。 */
export type OpenVikingVerifyFailureReason =
  /** 地址不可达：网络层失败、超时、DNS 解析失败 */
  | "unreachable"
  /** 地址可达但不是 OpenViking 服务（/health 非 OV 响应） */
  | "not_openviking"
  /** 鉴权失败：401/403，或使用了只能走管理面的 root key */
  | "unauthorized"
  /** 服务响应异常（非 2xx 或响应体不可解析） */
  | "server_error";

export interface OpenVikingVerifyResult {
  ok: boolean;
  reason?: OpenVikingVerifyFailureReason;
  /** 成功时的服务端版本号，来自 /health */
  version?: string;
  /** 面向用户的提示；不含任何凭据内容 */
  message?: string;
}

export interface OpenVikingIntegrationStatus {
  /** 集成是否可用：包内运行时存在且 CLI 配置指向当前包路径（26.5.9 起不再有复制释放目录） */
  installed: boolean;
  /** 已安装的集成版本（来自包内 hosts/zcode/openviking.integration.json） */
  version?: string;
  /** 运行时来源：恒为安装包内置（保留字段以兼容旧 UI 与序列化） */
  source?: "packaged" | "existing";
}

export interface IOpenVikingService {
  /** 只做连通性与鉴权校验，不落任何状态。 */
  verifyConnection(params: { url: string; userKey: string }): Promise<OpenVikingVerifyResult>;

  /**
   * 校验连接并写入配置（hooks + MCP + 连接文件），运行时直接指向包内路径（零复制）。
   * fail-closed：运行时缺失、配置合并失败、握手自检失败一律 reject。
   */
  install(params: { url: string; userKey: string }): Promise<OpenVikingIntegrationStatus>;

  /** 移除 hooks 与 MCP 配置段；不删除任何目录（agent-integrations 归官方安装器域）。 */
  uninstall(): Promise<void>;

  getStatus(): Promise<OpenVikingIntegrationStatus>;

  /**
   * 启动幂等对账：已启用但配置未指向当前包运行时（升级/换目录/被官方安装器改写）时重写。
   * 未启用时 no-op；运行时缺失时不动配置。由 host 启动时 fire-and-forget 调用。
   */
  reconcileStartup(): Promise<void>;
}

export const IOpenVikingService = createServiceDescriptor<IOpenVikingService>(
  ServiceChannels.OpenViking,
);
