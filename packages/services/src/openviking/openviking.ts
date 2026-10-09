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
  /** 集成运行时是否已释放到 <home>/.openviking/agent-integrations/ */
  installed: boolean;
  /** 已安装的集成版本（来自 integration.json） */
  version?: string;
  /** 运行时来源：安装包内置 / 用户目录既有 */
  source?: "packaged" | "existing";
}

export interface IOpenVikingService {
  /** 只做连通性与鉴权校验，不落任何状态。 */
  verifyConnection(params: { url: string; userKey: string }): Promise<OpenVikingVerifyResult>;

  /**
   * 释放内置运行时并写入配置（hooks + MCP + 连接文件）。
   * fail-closed：运行时缺失、配置合并失败一律 reject，不降级为「未安装但可用」。
   */
  install(params: { url: string; userKey: string }): Promise<OpenVikingIntegrationStatus>;

  /** 移除 hooks 与 MCP 配置段；运行时目录一并删除，ov.conf 等凭据文件保留。 */
  uninstall(): Promise<void>;

  getStatus(): Promise<OpenVikingIntegrationStatus>;
}

export const IOpenVikingService = createServiceDescriptor<IOpenVikingService>(
  ServiceChannels.OpenViking,
);