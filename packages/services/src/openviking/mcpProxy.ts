import { spawn } from "node:child_process";

/**
 * OpenViking MCP stdio 代理：安装条目构建与安装期握手自检。
 *
 * 从 openvikingService 拆出（2026-10-25 修复该文件超 400 行 max-lines 时分离）：
 * 本模块只关心「MCP 代理进程怎么拉起、怎么验证拉得起」，不碰 hooks/设置面。
 */

export const INTEGRATION_ID = "openviking-memory";
// 同步 vendor/openviking 时必须与 vendored integration.json / plugin.json 的 version
// 字段一起改：安装服务把本常量写进 hook 命令的 OPENVIKING_INTEGRATION_VERSION，
// 与模板里的 version 不一致会让上游按版本判定集成形态时走错分支。
export const INTEGRATION_VERSION = "0.5.23";

const MCP_HANDSHAKE_TIMEOUT_MS = 12_000;

export interface OpenVikingMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * MCP stdio 代理条目。桌面宿主是 Electron 应用：process.execPath 不带
 * ELECTRON_RUN_AS_NODE 时启动的是 GUI 本体（stdout 混入应用日志、无 JSON-RPC 响应、
 * 单实例合入后退出，宿主侧报 Connection closed），必须以 node 模式执行 .mjs。
 * dev/test 下 execPath 本来就是 node，该变量无副作用。契约见
 * docs/specs/memory-provider-selection.md「MCP 代理拉起契约与安装期握手自检」。
 */
export function buildOpenVikingMcpServerConfig(
  nodeBin: string,
  proxyPath: string,
): OpenVikingMcpServerConfig {
  return {
    command: nodeBin,
    args: [proxyPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      OPENVIKING_INTEGRATION_ID: INTEGRATION_ID,
      OPENVIKING_HOOK_SOURCE: "zcode",
    },
  };
}

/**
 * 用最终 command+args+env 真做一次 MCP 握手（initialize → initialized → tools/list）。
 * 2026-10-25 workwin 事故：安装器把宿主 GUI 可执行文件裸写为 command，hooks 正常而
 * MCP 全断的半开态存活数天——写盘后不实跑一次就永远发现不了。
 */
export async function verifyMcpProxyHandshake(
  server: OpenVikingMcpServerConfig,
  timeoutMs = MCP_HANDSHAKE_TIMEOUT_MS,
): Promise<{ toolCount: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";
    const settle = (settleFn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdin?.end();
      child.kill();
      settleFn();
    };
    const fail = (reason: string) =>
      settle(() =>
        reject(
          new Error(`${reason}${stderrTail ? `（stderr 尾部: ${stderrTail.slice(-400)}）` : ""}`),
        ),
      );
    const timer = setTimeout(() => fail(`OpenViking MCP 握手超时（${timeoutMs}ms）`), timeoutMs);
    child.on("error", (error) =>
      fail(`OpenViking MCP 代理无法启动（${server.command}）: ${error.message}`),
    );
    // GUI 本体、错误的二进制都会走到这里：进程起来了但说的不是 JSON-RPC。
    child.on("exit", (code, signal) =>
      fail(
        `OpenViking MCP 代理提前退出（code=${code} signal=${signal}）——command 未能以 node 语义执行 .mjs`,
      ),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineAt: number;
      while ((newlineAt = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineAt).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
        if (!line) continue;
        let message: {
          id?: number;
          result?: { tools?: unknown[] };
          error?: { message?: string };
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) fail(`initialize 失败: ${message.error.message ?? "未知错误"}`);
          else {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          }
          continue;
        }
        if (message.id === 2) {
          if (message.error) fail(`tools/list 失败: ${message.error.message ?? "未知错误"}`);
          else
            settle(() =>
              resolve({
                toolCount: Array.isArray(message.result?.tools) ? message.result.tools.length : 0,
              }),
            );
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "yazcode-install-check", version: INTEGRATION_VERSION },
      },
    });
  });
}
