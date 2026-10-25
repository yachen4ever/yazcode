import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenVikingMcpServerConfig,
  verifyMcpProxyHandshake,
} from "../src/openviking/mcpProxy.js";

test("MCP server 条目必须带 ELECTRON_RUN_AS_NODE——Electron 宿主裸 execPath 启动的是 GUI 本体", () => {
  const entry = buildOpenVikingMcpServerConfig("/path/to/yazcode.exe", "/path/to/mcp-proxy.mjs");
  assert.equal(entry.command, "/path/to/yazcode.exe");
  assert.deepEqual(entry.args, ["/path/to/mcp-proxy.mjs"]);
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(entry.env.OPENVIKING_INTEGRATION_ID, "openviking-memory");
  assert.equal(entry.env.OPENVIKING_HOOK_SOURCE, "zcode");
});

const FAKE_MCP_SERVER = [
  'let buf="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",(c)=>{buf+=c;let i;',
  'while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);',
  "if(!line.trim())continue;const m=JSON.parse(line);",
  'if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"fake"}}})+"\\n");',
  'if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:[{name:"a"},{name:"b"},{name:"c"}]}})+"\\n");}});',
].join("");

test("握手自检：完整 initialize → tools/list 链路返回工具数", async () => {
  const result = await verifyMcpProxyHandshake(
    {
      command: process.execPath,
      args: ["-e", FAKE_MCP_SERVER],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
    10_000,
  );
  assert.equal(result.toolCount, 3);
});

test("握手自检：说不了 JSON-RPC 就退出的进程必须显式失败（半开态防线）", async () => {
  await assert.rejects(
    verifyMcpProxyHandshake(
      {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("not json\\n"); process.exit(0);'],
        env: {},
      },
      10_000,
    ),
    /提前退出|握手超时/,
  );
});
