/**
 * 本机实测：用产品内的 IOpenVikingService 走一遍「校验 → 安装 → 状态 → 卸载」。
 * 不经过 yazcode-openviking 那个外部脚本，验证 vendored 运行时与配置合并是否成立。
 * 运行：./node_modules/.bin/tsx scripts/probe-ov-service.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenVikingService } from "../packages/services/src/openviking/openvikingService.js";

const KEY = process.env.PROBE_OV_KEY ?? "";
const URL = process.env.PROBE_OV_URL ?? "http://192.168.5.7:1933";
const service = createOpenVikingService();
const cliConfig = path.join(os.homedir(), ".yazcode", "cli", "config.json");

function hookCommandOf(): string {
  const config = JSON.parse(fs.readFileSync(cliConfig, "utf8"));
  return String(config?.hooks?.events?.SessionStart?.[0]?.hooks?.[0]?.command ?? "<缺失>");
}

async function main() {
  if (!KEY) {
    console.log("需要 PROBE_OV_KEY 环境变量（user key）。");
    process.exit(2);
  }

  console.log("== 1. 状态（安装前）==");
  console.log(JSON.stringify(await service.getStatus()));

  console.log("\n== 2. 错误 key 应被拒 ==");
  const bad = await service.verifyConnection({ url: URL, userKey: "invalid-key-for-probe" });
  console.log(JSON.stringify(bad));

  console.log("\n== 3. 正确 key 校验 ==");
  const good = await service.verifyConnection({ url: URL, userKey: KEY });
  console.log(JSON.stringify(good));
  if (!good.ok) {
    console.log("校验未通过，后续步骤跳过。");
    process.exit(1);
  }

  console.log("\n== 4. 安装 ==");
  const status = await service.install({ url: URL, userKey: KEY });
  console.log(JSON.stringify(status));

  console.log("\n== 5. 配置落地检查 ==");
  const config = JSON.parse(fs.readFileSync(cliConfig, "utf8"));
  console.log("hooks.enabled =", config?.hooks?.enabled);
  console.log("hook 事件 =", Object.keys(config?.hooks?.events ?? {}).join(","));
  console.log("MCP =", Object.keys(config?.mcp?.servers ?? {}).join(","));
  console.log("hook 命令 =", hookCommandOf());
  const ovHome = path.join(os.homedir(), ".openviking");
  console.log("ovcli.conf =", fs.existsSync(path.join(ovHome, "ovcli.conf")) ? "已写入" : "缺失");
  console.log(
    "运行时 =",
    fs.existsSync(path.join(ovHome, "agent-integrations", "zcode", "scripts", "hook.mjs"))
      ? "已释放"
      : "缺失",
  );

  console.log("\n== 6. 真实执行 hook（Windows shell）==");
  const { spawnSync } = await import("node:child_process");
  const stdin = JSON.stringify({
    session_id: "sess_product_probe",
    transcript_path: "C:\\nonexistent.jsonl",
    cwd: "D:\\Work",
    hook_event_name: "UserPromptSubmit",
    prompt: "拆机审批走哪个流程？",
  });
  const run = spawnSync(hookCommandOf(), {
    input: stdin,
    encoding: "utf8",
    timeout: 90000,
    shell: true,
  });
  console.log("exit =", run.status);
  const out = (run.stdout ?? "").slice(0, 400);
  console.log("stdout =", out || "(空)");

  console.log("\n== 7. 卸载 ==");
  await service.uninstall();
  const after = JSON.parse(fs.readFileSync(cliConfig, "utf8"));
  console.log("卸载后是否仍含 openviking =", JSON.stringify(after).includes("openviking"));
  console.log("卸载后 hook 事件 =", Object.keys(after?.hooks?.events ?? {}).join(",") || "(空)");
  console.log("ovcli.conf 是否保留 =", fs.existsSync(path.join(ovHome, "ovcli.conf")));
}

await main();