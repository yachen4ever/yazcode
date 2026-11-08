import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SSHConnectOptions } from "@zcode/shared";
import {
  computeHostKeyFingerprint,
  createSSHHostVerifier,
  formatHostKeyRejectionError,
  getSSHKnownHostsPath,
  SSHHostKeyStore,
  type SSHHostKeyRejection,
} from "@zcode/server/remote/sshKnownHosts.js";
import { buildSSHConnectConfig, normalizeSSHConnectError } from "@zcode/server/remote/sshAuth.js";

/**
 * SSH 主机密钥 TOFU 判定（26.5.7 修复批，移植自 axiom-desu/ZCodium@1575a769 的
 * vitest 用例，node:test+assert 转换——DMG 契约测试移植同款转换）。
 * 被测件经 server 包公开面（@zcode/server/remote/*.js）导入；语义契约见
 * docs/specs/ssh-remote-hardening.md。
 */

const target: SSHConnectOptions = {
  kind: "ssh",
  host: "deploy.example.com",
  port: 22,
  username: "root",
  privateKeyPath: "~/.ssh/id_ed25519",
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ssh-known-hosts-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function storePath(): string {
  return join(directory, "known-hosts.json");
}

function fingerprintOf(seed: string): string {
  return computeHostKeyFingerprint(Buffer.from(seed));
}

describe("SSHHostKeyStore", () => {
  it("首连接受并落库，记录含算法与指纹", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    const verdict = await store.verify(target, fingerprintOf("server-key-1"));

    assert.equal(verdict.outcome, "first-use");
    const persisted = JSON.parse(await readFile(storePath(), "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    const records = Object.values(persisted.hosts) as Array<Record<string, string>>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.fingerprint, fingerprintOf("server-key-1"));
    assert.equal(records[0]?.algorithm, "sha256");
  });

  it("记录匹配时再次连接接受", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    assert.equal(verdict.outcome, "match");
  });

  it("指纹不一致时拒绝，且不覆盖已有记录", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const verdict = await store.verify(target, fingerprintOf("attacker-key"));
    assert.equal(verdict.outcome, "reject");
    if (verdict.outcome !== "reject" || verdict.reason !== "changed") {
      throw new Error("unreachable");
    }
    assert.equal(verdict.expected, fingerprintOf("server-key-1"));
    assert.equal(verdict.received, fingerprintOf("attacker-key"));

    const persisted = JSON.parse(await readFile(storePath(), "utf8"));
    const records = Object.values(persisted.hosts) as Array<Record<string, string>>;
    assert.equal(records[0]?.fingerprint, fingerprintOf("server-key-1"));
  });

  it("存储键不含凭据：仅密码不同的同一主机共享判定", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify({ ...target, password: "first-password" }, fingerprintOf("server-key-1"));

    const verdict = await store.verify(
      { ...target, password: "other-password" },
      fingerprintOf("server-key-1"),
    );
    assert.equal(verdict.outcome, "match");

    const raw = await readFile(storePath(), "utf8");
    assert.equal(raw.includes("first-password"), false);
    assert.equal(raw.includes("other-password"), false);
  });

  it("known_hosts 损坏时 fail-closed 拒绝，且不静默重建", async () => {
    await writeFile(storePath(), "{ not json", "utf8");
    const store = new SSHHostKeyStore({ filePath: storePath() });

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    assert.equal(verdict.outcome, "reject");
    if (verdict.outcome !== "reject") throw new Error("unreachable");
    assert.equal(verdict.reason, "store-error");
  });

  it("schema 不兼容时 fail-closed 拒绝", async () => {
    await writeFile(storePath(), JSON.stringify({ schemaVersion: 999, hosts: {} }), "utf8");
    const store = new SSHHostKeyStore({ filePath: storePath() });

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    assert.equal(verdict.outcome, "reject");
  });
});

describe("createSSHHostVerifier", () => {
  it("首连回调 verify(true)，不记录拒绝", async () => {
    const rejections: SSHHostKeyRejection[] = [];
    const verifier = createSSHHostVerifier({
      store: new SSHHostKeyStore({ filePath: storePath() }),
      target,
      onRejection: (rejection) => rejections.push(rejection),
    });

    const ok = await new Promise<boolean>((resolve) => {
      verifier(Buffer.from("server-key-1"), resolve);
    });
    assert.equal(ok, true);
    assert.equal(rejections.length, 0);
  });

  it("密钥变更先记录可区分的拒绝原因，再回调 verify(false)", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const rejections: SSHHostKeyRejection[] = [];
    const verifier = createSSHHostVerifier({
      store,
      target,
      onRejection: (rejection) => rejections.push(rejection),
    });

    const ok = await new Promise<boolean>((resolve) => {
      verifier(Buffer.from("attacker-key"), resolve);
    });
    assert.equal(ok, false);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]?.reason, "changed");
  });
});

describe("formatHostKeyRejectionError", () => {
  it("密钥变更的错误带安全语义与清理路径", () => {
    const error = formatHostKeyRejectionError(
      { hostKey: "k", reason: "changed", detail: "ignored" },
      "/data/known-hosts.json",
    );
    assert.equal(error.message.includes("中间人"), true);
    assert.equal(error.message.includes("/data/known-hosts.json"), true);
  });

  it("存储故障的错误带环境原因，不谎称密钥变更", () => {
    const error = formatHostKeyRejectionError(
      { hostKey: "k", reason: "store-error", detail: "EACCES" },
      "/data/known-hosts.json",
    );
    assert.equal(error.message.includes("EACCES"), true);
    assert.equal(error.message.includes("中间人"), false);
  });
});

describe("sshAuth 接线", () => {
  it("buildSSHConnectConfig 透传 hostVerifier", () => {
    const hostVerifier = () => {};
    const config = buildSSHConnectConfig({
      host: "deploy.example.com",
      username: "root",
      hostVerifier,
    });
    assert.equal(config.hostVerifier, hostVerifier);
  });

  it("normalizeSSHConnectError 把 ssh2 的 host denied 映射为产品文案", () => {
    const error = normalizeSSHConnectError(new Error("Host denied (verification failed)"));
    assert.equal(error.message.includes("主机密钥校验未通过"), true);
  });

  it("其余 SSH 错误文案不受影响", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    assert.equal(error.message.includes("认证失败"), true);
  });
});

describe("getSSHKnownHostsPath", () => {
  it("落在应用配置根的 ssh 子目录", () => {
    assert.equal(getSSHKnownHostsPath().includes("ssh"), true);
    assert.equal(getSSHKnownHostsPath().endsWith("known-hosts.json"), true);
  });
});
