import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import {
  createOpenVikingService,
  isIntegrationConfigured,
} from "../src/openviking/openvikingService.js";

/** 假 mcp-proxy：对 initialize / tools/list 回最小 JSON-RPC，供安装期握手自检通过。 */
const FAKE_MCP_SERVER = [
  'let buf="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",(c)=>{buf+=c;let i;',
  'while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);',
  "if(!line.trim())continue;const m=JSON.parse(line);",
  'if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"fake"}}})+"\\n");',
  'if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:[{name:"a"}]}})+"\\n");}});',
].join("");

const HOOK_TEMPLATE = {
  hooks: {
    SessionStart: [
      { hooks: [{ command: "node __OPENVIKING_PLUGIN_ROOT__/scripts/hook.mjs session-start", timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ command: "node __OPENVIKING_PLUGIN_ROOT__/scripts/hook.mjs prompt-submit", timeout: 10 }] },
    ],
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ command: "node __OPENVIKING_PLUGIN_ROOT__/scripts/hook.mjs pre-tool", timeout: 10 }],
      },
    ],
    Stop: [{ hooks: [{ command: "node __OPENVIKING_PLUGIN_ROOT__/scripts/hook.mjs stop", timeout: 10 }] }],
  },
};

/** 按 resolvePackagedRuntimeRoot 的判定条件造一个「包内运行时」。 */
function writeFakeRuntime(runtimeRoot: string): void {
  const zcode = path.join(runtimeRoot, "zcode");
  fs.mkdirSync(path.join(zcode, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(zcode, "scripts", "hook.mjs"), "// fake hook\n");
  const hostDir = path.join(zcode, "hosts", "zcode");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, "hooks.json"), JSON.stringify(HOOK_TEMPLATE));
  fs.writeFileSync(
    path.join(hostDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { openviking: { command: "node", args: ["servers/mcp-proxy.mjs"] } } }),
  );
  fs.writeFileSync(
    path.join(hostDir, "openviking.integration.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "openviking-memory",
      version: "0.5.31",
      clients: ["zcode"],
      capabilities: ["hooks", "mcp"],
    }),
  );
  fs.mkdirSync(path.join(zcode, "servers"), { recursive: true });
  fs.writeFileSync(path.join(zcode, "servers", "mcp-proxy.mjs"), FAKE_MCP_SERVER);
  fs.mkdirSync(path.join(runtimeRoot, "memory-plugin-shared", "lib"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "memory-plugin-shared", "lib", "MANIFEST"), "ov-http.mjs\n");
}

interface Sandbox {
  runtimeRoot: string;
  home: string;
  ovHome: string;
  cliConfig: string;
  url: string;
}

function startFakeOvServer(
  options: { rejectData?: boolean } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version: "0.5.3" }));
      return;
    }
    if (req.url?.startsWith("/api/v1/fs/ls")) {
      if (options.rejectData) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function withSandbox(
  fn: (sandbox: Sandbox) => Promise<void>,
  options: { runtime?: boolean; rejectData?: boolean } = {},
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ov-svc-test-"));
  const resourcesDir = path.join(tmp, "resources");
  const runtimeRoot = path.join(resourcesDir, "openviking");
  if (options.runtime !== false) writeFakeRuntime(runtimeRoot);
  else fs.mkdirSync(resourcesDir, { recursive: true });
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const ovHome = path.join(tmp, "ovhome");
  const server = await startFakeOvServer({ rejectData: options.rejectData });

  const proc = process as { resourcesPath?: string };
  const prev = {
    HOME: process.env.HOME,
    OPENVIKING_HOME: process.env.OPENVIKING_HOME,
    resourcesPath: proc.resourcesPath,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  process.env.OPENVIKING_HOME = ovHome;
  proc.resourcesPath = resourcesDir;
  // 防止 cwd 上溯在仓库里找到真实的 vendor/openviking（「运行时缺失」用例依赖这一点）。
  process.chdir(tmp);
  try {
    await fn({
      runtimeRoot,
      home,
      ovHome,
      cliConfig: path.join(home, ".yazcode", "cli", "config.json"),
      url: server.url,
    });
  } finally {
    process.chdir(prev.cwd);
    proc.resourcesPath = prev.resourcesPath;
    if (prev.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = prev.HOME;
    if (prev.OPENVIKING_HOME === undefined) delete process.env.OPENVIKING_HOME;
    else process.env.OPENVIKING_HOME = prev.OPENVIKING_HOME;
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("install：hooks/MCP 指向包内运行时，零复制，握手自检通过", async () => {
  await withSandbox(async (sandbox) => {
    const service = createOpenVikingService();
    const status = await service.install({ url: sandbox.url, userKey: "user-key" });
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.5.31");
    assert.equal(status.source, "packaged");

    const config = JSON.parse(fs.readFileSync(sandbox.cliConfig, "utf8")) as {
      hooks: unknown;
      mcp: { servers: Record<string, { args: string[] }> };
    };
    const normalizedRoot = sandbox.runtimeRoot.replace(/\\/gu, "/");
    assert.ok(JSON.stringify(config.hooks).includes(`${normalizedRoot}/zcode/scripts/hook.mjs`));
    assert.equal(
      config.mcp.servers.openviking?.args[0],
      path.join(sandbox.runtimeRoot, "zcode", "servers", "mcp-proxy.mjs"),
    );
    // 零复制：不再写 agent-integrations
    assert.equal(fs.existsSync(path.join(sandbox.ovHome, "agent-integrations")), false);
    const conf = JSON.parse(fs.readFileSync(path.join(sandbox.ovHome, "ovcli.conf"), "utf8")) as {
      url: string;
      api_key: string;
    };
    assert.equal(conf.url, sandbox.url);
    assert.equal(conf.api_key, "user-key");
    assert.equal(isIntegrationConfigured(), true);
  });
});

test("getStatus：配置指向旧 agent-integrations 路径时判定未安装", async () => {
  await withSandbox(async (sandbox) => {
    const service = createOpenVikingService();
    assert.deepEqual(await service.getStatus(), { installed: false });
    // 造一份旧复制释放模式的存量配置
    fs.mkdirSync(path.dirname(sandbox.cliConfig), { recursive: true });
    const legacyRoot = path.join(sandbox.ovHome, "agent-integrations", "zcode");
    fs.writeFileSync(
      sandbox.cliConfig,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `set "OPENVIKING_HOOK_SOURCE=zcode" && node ${legacyRoot}/scripts/hook.mjs`,
                  },
                ],
              },
            ],
          },
        },
        mcp: { servers: { openviking: { command: "node", args: [`${legacyRoot}/servers/mcp-proxy.mjs`] } } },
      }),
    );
    assert.deepEqual(await service.getStatus(), { installed: false });
  });
});

test("getStatus：配置指向当前包路径时判定已安装并报告包内版本", async () => {
  await withSandbox(async (sandbox) => {
    const service = createOpenVikingService();
    await service.install({ url: sandbox.url, userKey: "user-key" });
    const status = await service.getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.5.31");
    assert.equal(status.source, "packaged");
  });
});

test("reconcileStartup：未启用 no-op；旧路径重写为包内；已一致幂等", async () => {
  await withSandbox(async (sandbox) => {
    const service = createOpenVikingService();

    // 未启用：不管
    await service.reconcileStartup();
    assert.equal(fs.existsSync(sandbox.cliConfig), false);

    // 旧路径配置：重写为包内
    fs.mkdirSync(path.dirname(sandbox.cliConfig), { recursive: true });
    const legacyRoot = path.join(sandbox.ovHome, "agent-integrations", "zcode");
    fs.writeFileSync(
      sandbox.cliConfig,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              { hooks: [{ type: "command", command: `node ${legacyRoot}/scripts/hook.mjs session-start` }] },
            ],
          },
        },
        mcp: { servers: { openviking: { command: "node", args: [`${legacyRoot}/servers/mcp-proxy.mjs`] } } },
      }),
    );
    await service.reconcileStartup();
    const rewritten = fs.readFileSync(sandbox.cliConfig, "utf8");
    assert.ok(rewritten.includes(path.join(sandbox.runtimeRoot, "zcode").replace(/\\/gu, "/")));
    assert.equal((await service.getStatus()).installed, true);

    // 已一致：内容不变（幂等）
    await service.reconcileStartup();
    assert.equal(fs.readFileSync(sandbox.cliConfig, "utf8"), rewritten);
  });
});

test("uninstall：只移除配置段，agent-integrations 目录保留", async () => {
  await withSandbox(async (sandbox) => {
    const service = createOpenVikingService();
    await service.install({ url: sandbox.url, userKey: "user-key" });
    // 预置官方安装器域目录，验证不被误删
    const shared = path.join(sandbox.ovHome, "agent-integrations", "zcode");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "marker.txt"), "official\n");

    await service.uninstall();
    assert.equal(isIntegrationConfigured(), false);
    assert.equal(fs.existsSync(path.join(shared, "marker.txt")), true);
    assert.deepEqual(await service.getStatus(), { installed: false });
  });
});

test("install：包内运行时缺失必须显式报错（fail-closed）", async () => {
  await withSandbox(
    async (sandbox) => {
      const service = createOpenVikingService();
      await assert.rejects(
        () => service.install({ url: sandbox.url, userKey: "user-key" }),
        /OpenViking 运行时缺失/,
      );
      assert.equal(fs.existsSync(sandbox.cliConfig), false);
    },
    { runtime: false },
  );
});

// ── 连接配置对账（26.5.10，issue #38，spec memory-provider-selection.md）────────────
// 双密钥源脱钩：settings 表单事实源（openvikingConnection）vs 运行时事实源
// （ovcli.conf）。启动对账仅在「两源不一致且 ovcli key 数据面校验有效」时以
// ovcli 值同步回表单；只读 ovcli.conf，写入走 settings 端口。

function makeSettingsPort(connection?: { url: string; userKey: string }) {
  const writes: Array<{ url: string; userKey: string }> = [];
  return {
    writes,
    port: {
      read: async () => connection,
      write: async (next: { url: string; userKey: string }) => {
        writes.push(next);
      },
    },
  };
}

function writeOvcliConf(sandbox: Sandbox, connection: { url: string; apiKey: string }): void {
  fs.mkdirSync(sandbox.ovHome, { recursive: true });
  fs.writeFileSync(
    path.join(sandbox.ovHome, "ovcli.conf"),
    JSON.stringify({ url: connection.url, api_key: connection.apiKey }),
  );
}

test("连接对账：两源一致 no-op（无写入、无网络校验）", async () => {
  await withSandbox(
    async (sandbox) => {
      writeOvcliConf(sandbox, { url: sandbox.url, apiKey: "same-key" });
      const settings = makeSettingsPort({ url: sandbox.url, userKey: "same-key" });
      const service = createOpenVikingService({ connectionSettings: settings.port });
      await service.reconcileStartup();
      assert.equal(settings.writes.length, 0);
    },
    { runtime: false },
  );
});

test("连接对账：未启用档位（无 openvikingConnection）no-op", async () => {
  await withSandbox(
    async (sandbox) => {
      writeOvcliConf(sandbox, { url: sandbox.url, apiKey: "ovcli-key" });
      const settings = makeSettingsPort(undefined);
      const service = createOpenVikingService({ connectionSettings: settings.port });
      await service.reconcileStartup();
      assert.equal(settings.writes.length, 0);
    },
    { runtime: false },
  );
});

test("连接对账：ovcli.conf 缺失 no-op（不掩盖设置页真实报错）", async () => {
  await withSandbox(
    async () => {
      const settings = makeSettingsPort({ url: "http://stale:1933", userKey: "stale-key" });
      const service = createOpenVikingService({ connectionSettings: settings.port });
      await service.reconcileStartup();
      assert.equal(settings.writes.length, 0);
    },
    { runtime: false },
  );
});

test("连接对账：不一致且 ovcli key 有效 → 以 ovcli 值同步回 settings", async () => {
  await withSandbox(
    async (sandbox) => {
      // workwin 实测形态：表单残留外部安装器更新前的旧 key（104 字符），ovcli 为新 key。
      writeOvcliConf(sandbox, { url: sandbox.url, apiKey: "fresh-ovcli-key" });
      const settings = makeSettingsPort({
        url: "http://stale:1933",
        userKey: "stale-form-key",
      });
      const service = createOpenVikingService({ connectionSettings: settings.port });
      await service.reconcileStartup();
      assert.deepEqual(settings.writes, [{ url: sandbox.url, userKey: "fresh-ovcli-key" }]);
    },
    { runtime: false },
  );
});

test("连接对账：不一致但 ovcli key 也无效（401）→ 保持现状不写入", async () => {
  await withSandbox(
    async (sandbox) => {
      writeOvcliConf(sandbox, { url: sandbox.url, apiKey: "invalid-ovcli-key" });
      const settings = makeSettingsPort({
        url: "http://stale:1933",
        userKey: "stale-form-key",
      });
      const service = createOpenVikingService({ connectionSettings: settings.port });
      await service.reconcileStartup();
      assert.equal(settings.writes.length, 0);
    },
    { runtime: false, rejectData: true },
  );
});
