import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRemoteProjectRoots,
  assertRemoteTaskDirectories,
  isRemoteProjectHostId,
} from "../src/session/remotePolicy.js";
import type { ProjectRecord } from "../src/session/projectRepository.js";

/** 远端单 root 策略纯断言（docs/specs/multi-root-projects.md「远程边界（P4）」）。 */
describe("remotePolicy", () => {
  const remoteHost = "ssh:test-host";
  function project(hostId: string, ...rootPaths: string[]): ProjectRecord {
    return {
      projectId: "proj_test",
      hostId,
      name: "p",
      defaultName: null,
      pinned: false,
      roots: rootPaths.map((rootPath, position) => ({
        rootPath,
        position,
        isPrimary: position === 0,
      })),
    };
  }

  describe("isRemoteProjectHostId", () => {
    it("undefined / 空白 / local 即本地，其余即远端", () => {
      for (const hostId of [undefined, null, "", "   ", "local"]) {
        assert.equal(isRemoteProjectHostId(hostId), false, `hostId=${String(hostId)}`);
      }
      assert.equal(isRemoteProjectHostId("ssh:h"), true);
      assert.equal(isRemoteProjectHostId(" wsl:ubuntu "), true);
    });
  });

  describe("assertRemoteProjectRoots", () => {
    it("本地 hostId 不约束：多 root 可存", () => {
      for (const hostId of [undefined, "local"]) {
        assert.doesNotThrow(() => assertRemoteProjectRoots(hostId, ["/a", "/b"]));
      }
    });

    it("远端新建必须恰好单 root", () => {
      assert.throws(
        () => assertRemoteProjectRoots(remoteHost, []),
        /project.remote-single-root-required/,
      );
      assert.throws(
        () => assertRemoteProjectRoots(remoteHost, ["/a", "/b"]),
        /project.remote-single-root-required/,
      );
      assert.doesNotThrow(() => assertRemoteProjectRoots(remoteHost, ["/a"]));
    });

    it("远端更新 root 不可变；元数据场景 roots 不变即通过", () => {
      const previous = project(remoteHost, "/a");
      assert.doesNotThrow(() => assertRemoteProjectRoots(remoteHost, ["/a"], previous));
      assert.throws(
        () => assertRemoteProjectRoots(remoteHost, ["/b"], previous),
        /project.remote-root-immutable/,
      );
      assert.throws(
        () => assertRemoteProjectRoots(remoteHost, ["/a", "/b"], previous),
        /project.remote-single-root-required/,
      );
    });
  });

  describe("assertRemoteTaskDirectories", () => {
    it("本地 hostId 不约束", () => {
      assert.doesNotThrow(() =>
        assertRemoteTaskDirectories("local", project("local", "/a", "/b"), "/a", ["/b"]),
      );
    });

    it("远端缺项目即拒（remote-project-required）", () => {
      assert.throws(
        () => assertRemoteTaskDirectories(remoteHost, null, "/a", []),
        /project.remote-project-required/,
      );
      assert.throws(
        () => assertRemoteTaskDirectories(remoteHost, undefined, "/a", []),
        /project.remote-project-required/,
      );
    });

    it("远端项目 roots 被篡改成多 root 即拒", () => {
      assert.throws(
        () => assertRemoteTaskDirectories(remoteHost, project(remoteHost, "/a", "/b"), "/a", []),
        /project.remote-single-root-required/,
      );
    });

    it("远端附加目录非空即拒；cwd 不在唯一 root 即拒", () => {
      assert.throws(
        () => assertRemoteTaskDirectories(remoteHost, project(remoteHost, "/a"), "/a", ["/b"]),
        /project.remote-single-root-required/,
      );
      assert.throws(
        () => assertRemoteTaskDirectories(remoteHost, project(remoteHost, "/a"), "/b", []),
        /project.cwd-not-in-roots/,
      );
      assert.doesNotThrow(() =>
        assertRemoteTaskDirectories(remoteHost, project(remoteHost, "/a"), "/a", []),
      );
    });
  });
});
