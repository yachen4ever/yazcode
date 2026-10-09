/** 召回验证：安装后真实执行 UserPromptSubmit，看 OV 是否注入相关记忆。 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenVikingService } from "../packages/services/src/openviking/openvikingService.js";

async function main() {
  const key = process.env.PROBE_OV_KEY ?? "";
  if (!key) {
    console.log("需要 PROBE_OV_KEY");
    process.exit(2);
  }
  const service = createOpenVikingService();
  await service.install({ url: "http://192.168.5.7:1933", userKey: key });

  const configPath = path.join(os.homedir(), ".yazcode", "cli", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const command: string = config.hooks.events.UserPromptSubmit[0].hooks[0].command;

  const run = spawnSync(command, {
    input: JSON.stringify({
      session_id: "sess_final_recall",
      transcript_path: "C:\\nonexistent.jsonl",
      cwd: "D:\\Work",
      hook_event_name: "UserPromptSubmit",
      prompt: "拆机审批走哪个流程？",
    }),
    encoding: "utf8",
    timeout: 90000,
    shell: true,
  });
  console.log("exit =", run.status);
  if (run.stderr) console.log("stderr =", run.stderr.slice(0, 300));
  console.log((run.stdout ?? "").slice(0, 1200) || "(空)");
}

await main();