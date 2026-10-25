import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { USERSCRIPT_IPC_CHANNELS } from "../src/main/userscripts/userscriptIpcContract.js";

/**
 * runtime 的运行时行为（隔离世界、document_start、IPC 往返）无法在 node:test 内复现，
 * 这里锚定可静态验证的契约面；实机断言（页面摸不到 GM_* 等）为 fixture 实测项，
 * 见 docs/specs/iab-userscripts.md 验收场景 9。
 */

const runtimeSource = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "../src/preload/userscriptRuntime.ts"),
  "utf8",
);

describe("userscriptRuntime 静态契约", () => {
  it("单文件行数 ≤250（app 内置静态资源的体积约束）", () => {
    assert.ok(runtimeSource.split("\n").length <= 250, "runtime 源码应保持 ≤250 行");
  });

  it("不引入 electron 之外的任何模块（沙箱 preload 的合法 require 面之外无依赖）", () => {
    const imports = [...runtimeSource.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(imports.includes("electron"), "runtime 需要 ipcRenderer");
    for (const specifier of imports) {
      assert.ok(
        specifier === "electron" || specifier.startsWith("../main/userscripts/"),
        `非法导入: ${specifier}`,
      );
    }
    assert.ok(!/require\(/.test(runtimeSource.replace(/\*[^]*?\*\//g, " ")), "不得出现运行时 require");
  });

  it("不暴露 contextBridge：页面主世界不得获得任何由 runtime 注册的全局桥", () => {
    assert.ok(!runtimeSource.includes("contextBridge"), "GM_* 以函数参数注入，禁止 contextBridge");
    assert.ok(!runtimeSource.includes("exposeInMainWorld"));
  });

  it("复用与 main 同源的判定模块（channel/协议判定不复制字符串）", () => {
    assert.ok(
      runtimeSource.includes('from "../main/userscripts/userscriptIpcContract.js"'),
      "channel 常量必须 import 自契约模块",
    );
    assert.ok(
      runtimeSource.includes('from "../main/userscripts/userscriptRules.js"'),
      "协议判定必须 import 自 rules 模块",
    );
    assert.ok(runtimeSource.includes("USERSCRIPT_IPC_CHANNELS.match"));
    assert.ok(runtimeSource.includes("USERSCRIPT_IPC_CHANNELS.get"));
    assert.ok(runtimeSource.includes("USERSCRIPT_IPC_CHANNELS.set"));
  });

  it("存在非 http(s) no-op 守卫与 frame 幂等守卫", () => {
    assert.ok(runtimeSource.includes("isInjectableUrlProtocol(url.protocol)"));
    assert.ok(runtimeSource.includes("RUNTIME_INSTALLED_FLAG"));
  });

  it("GM 六函数以 new Function 参数注入，存储走 sendSync（Tampermonkey 同步语义）", () => {
    for (const gmName of ["GM_info", "GM_addStyle", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"]) {
      assert.ok(runtimeSource.includes(`"${gmName}"`), gmName);
    }
    assert.ok(runtimeSource.includes("ipcRenderer.sendSync"));
    assert.ok(runtimeSource.includes("ipcRenderer.invoke"));
  });

  it("契约 channel 名与文档约定一致（zcode:userscripts:*）", () => {
    assert.equal(USERSCRIPT_IPC_CHANNELS.match, "zcode:userscripts:match");
    assert.equal(USERSCRIPT_IPC_CHANNELS.get, "zcode:userscripts:get");
    assert.equal(USERSCRIPT_IPC_CHANNELS.set, "zcode:userscripts:set");
  });
});
