import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { testProviderModelConnectivity } from "./workspace-model-runtime.js";
import { createRegistryRefreshFreshness } from "./registry-refresh-freshness.js";
import type { ZCodeApp } from "../app/types.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 探针前缀段（26.5.8，spec probe-registry-refresh-dedup.md）：
 * - accountConfigPushed=true（host 已推送 account config，接收 handler 已刷新
 *   registry）→ 探测 handler 跳过第二次 registry refresh；
 * - 缺省/缺字段（revision 未变，host 未推送）→ 照旧刷新（personal config
 *   watcher 漏事件防线）；
 * - 无活跃会话的连续探测复用缓存的 app（createZCodeApp 只调一次），TTL 到期
 *   关闭恰好一次；有活跃会话时优先会话 app。
 *
 * 所有用例统一 fake timers：正常路径的 finally 也会武装 60s eviction timer，
 * 真实定时器会把测试进程拖满一个 TTL。
 */

const workspaceRef = {
  workspacePath: "/tmp/ws",
  workspaceKey: "k:/tmp/ws",
};

const selection = { providerId: "p1", modelId: "m1" };

type FakeApp = {
  app: ZCodeApp;
  testModelConnectivity: ReturnType<typeof mock.fn<() => Promise<void>>>;
  close: ReturnType<typeof mock.fn<() => Promise<void>>>;
};

function makeFakeApp(): FakeApp {
  const testModelConnectivity = mock.fn(async () => {});
  const close = mock.fn(async () => {});
  const app = { testModelConnectivity, close } as unknown as ZCodeApp;
  return { app, testModelConnectivity, close };
}

type Harness = {
  context: ZCodeProtocolAgentServerContext;
  createZCodeApp: ReturnType<typeof mock.fn<() => Promise<ZCodeApp>>>;
  refreshProviderRegistry: ReturnType<typeof mock.fn<(reason: string) => Promise<void>>>;
  apps: FakeApp[];
  sessions: Map<string, { app: ZCodeApp; workspace: { workspaceKey: string } }>;
};

function makeHarness(
  options: {
    registryRefreshCurrent?: boolean;
    freshness?: import("./registry-refresh-freshness.js").RegistryRefreshFreshness;
  } = {},
): Harness {
  const apps: FakeApp[] = [];
  const createZCodeApp = mock.fn(async () => {
    const fake = makeFakeApp();
    apps.push(fake);
    return fake.app;
  });
  const refreshProviderRegistry = mock.fn(async (_reason: string) => {});
  const sessions = new Map<string, { app: ZCodeApp; workspace: { workspaceKey: string } }>();
  const context = {
    deps: {
      env: {},
      sessionStore: {},
      version: "test",
      createZCodeApp,
      refreshProviderRegistry,
      ...(options.freshness
        ? { isRegistryRefreshCurrent: () => options.freshness!.isCurrent() }
        : options.registryRefreshCurrent === undefined
          ? {}
          : { isRegistryRefreshCurrent: () => options.registryRefreshCurrent === true }),
    },
    sessions,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, createZCodeApp, refreshProviderRegistry, apps, sessions };
}

function probeParams(accountConfigPushed?: boolean) {
  return {
    workspace: { ...workspaceRef },
    selection,
    ...(accountConfigPushed === undefined ? {} : { accountConfigPushed }),
  };
}

function withFakeTimers(run: () => Promise<void>): Promise<void> {
  const timers = mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  return run().finally(() => {
    timers.reset();
  });
}

describe("testProviderModelConnectivity 前缀段", () => {
  it("pushed=true 且刷新自证新鲜：跳过 registry refresh（去重成立）", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness({ registryRefreshCurrent: true });
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 0);
      assert.equal(h.createZCodeApp.mock.callCount(), 1);
      assert.equal(h.apps[0]?.testModelConnectivity.mock.callCount(), 1);
    });
  });

  it("pushed=true 但刷新不新鲜：照旧刷新（26.5.8 退化形态回归守卫）", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness({ registryRefreshCurrent: false });
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 1);
    });
  });

  it("保存落盘晚于推送刷新：config 变更后探测必须自行刷新（#29 竞态回归）", async () => {
    await withFakeTimers(async () => {
      const freshness = createRegistryRefreshFreshness();
      const h = makeHarness({ freshness });
      // 推送 handler 的 refresh A 完成（基于旧 personal）→ 记为已覆盖
      freshness.markRefreshCurrent();
      // 保存 Base URL 落盘 → config 源变更（新的 personal 尚未被任何 refresh 覆盖）
      freshness.noteConfigChange();
      await testProviderModelConnectivity(h.context, probeParams(true));
      // 自证不成立 → 必须执行刷新 B，否则会读到旧 Base URL（26.5.8 退化形态）
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 1);
    });
  });

  it("pushed=true 且未装配自证：照旧刷新（fail-open 安全侧）", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 1);
    });
  });

  it("缺省（host 未推送）：照旧刷新（watcher 漏事件防线）", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      await testProviderModelConnectivity(h.context, probeParams());
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 1);
      assert.equal(
        h.refreshProviderRegistry.mock.calls[0]?.arguments[0],
        "provider-connectivity",
      );
    });
  });

  it("accountConfigPushed=false（revision 未变）：照旧刷新", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      await testProviderModelConnectivity(h.context, probeParams(false));
      assert.equal(h.refreshProviderRegistry.mock.callCount(), 1);
    });
  });

  it("连续探测复用缓存 app：createZCodeApp 只调一次，TTL 内不关闭", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      await testProviderModelConnectivity(h.context, probeParams(true));
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.createZCodeApp.mock.callCount(), 1);
      assert.equal(h.apps[0]?.close.mock.callCount(), 0);
    });
  });

  it("TTL 到期后关闭恰好一次，后续探测创建新 app", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.createZCodeApp.mock.callCount(), 1);
      mock.timers.tick(60_000);
      // close 在 timer 回调里发起；等微任务清空后再断言。
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(h.apps[0]?.close.mock.callCount(), 1);
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.createZCodeApp.mock.callCount(), 2);
    });
  });

  it("有活跃会话时优先会话 app，不新建也不关闭会话 app", async () => {
    await withFakeTimers(async () => {
      const h = makeHarness();
      const session = makeFakeApp();
      h.sessions.set("s1", {
        app: session.app,
        workspace: { workspaceKey: workspaceRef.workspaceKey },
      });
      await testProviderModelConnectivity(h.context, probeParams(true));
      assert.equal(h.createZCodeApp.mock.callCount(), 0);
      assert.equal(session.testModelConnectivity.mock.callCount(), 1);
      assert.equal(session.close.mock.callCount(), 0);
    });
  });
});
