import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
} from "../src/zcode-protocol/index.js";
import { v4ConversationSubscribeParamsSchema } from "../src/zcode-protocol-v4/transport.js";
import { ZCODE_ADDITIONAL_DIRECTORIES_MAX_ITEMS } from "../src/zcode-protocol-legacy-types.js";

// 多目录项目协议三通道（docs/specs/multi-root-projects.md「协议三通道（P2）」）：
// session create / session resume / V4 冷恢复三处 additionalDirectories 字段同形——
// 可选、array、max 256、每项非空 trimmed string；strict 拒绝未知键。

const validWorkspace = {
  workspacePath: "/tmp/project",
  workspaceKey: "/tmp/project",
};

const schemas = [
  { name: "session create", schema: zcodeSessionCreateParamsSchema },
  { name: "session resume", schema: zcodeSessionResumeParamsSchema },
  { name: "v4 cold recovery", schema: v4ConversationSubscribeParamsSchema },
] as const;

/** 按通道构造携带附加目录的最小合法 params（zod parse 输入）。 */
function paramsWith(
  schema: (typeof schemas)[number]["schema"],
  additionalDirectories: unknown,
): Record<string, unknown> {
  if (schema === zcodeSessionCreateParamsSchema) {
    return { workspace: validWorkspace, additionalDirectories };
  }
  if (schema === zcodeSessionResumeParamsSchema) {
    return { sessionId: "s-1", additionalDirectories };
  }
  return {
    topic: "conversation/s-1",
    connectionId: "c-1",
    clientMode: "desktop-continuous",
    additionalDirectories,
  };
}

function makePaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/tmp/dir-${index}`);
}

describe("additionalDirectories 协议三通道 schema", () => {
  it("三通道都接受合法附加目录并可缺省", () => {
    const additionalDirectories = ["/tmp/alpha", "/tmp/beta"];
    for (const { schema } of schemas) {
      const parsed = schema.parse(paramsWith(schema, additionalDirectories)) as {
        additionalDirectories?: string[];
      };
      assert.deepEqual(parsed.additionalDirectories, additionalDirectories);
    }
    // 缺省 = 无附加目录（不注入默认值）。
    assert.equal(
      zcodeSessionCreateParamsSchema.parse({ workspace: validWorkspace }).additionalDirectories,
      undefined,
    );
    assert.equal(
      zcodeSessionResumeParamsSchema.parse({ sessionId: "s-1" }).additionalDirectories,
      undefined,
    );
  });

  it("每项 trim 归一；trim 后为空串拒绝", () => {
    const parsed = zcodeSessionCreateParamsSchema.parse({
      workspace: validWorkspace,
      additionalDirectories: ["  /tmp/spaced  ", "/tmp/b"],
    }) as { additionalDirectories: string[] };
    assert.deepEqual(parsed.additionalDirectories, ["/tmp/spaced", "/tmp/b"]);

    for (const { name, schema } of schemas) {
      assert.throws(
        () => schema.parse(paramsWith(schema, ["   "])),
        undefined,
        `${name} 应拒绝空白项`,
      );
    }
  });

  it(`${ZCODE_ADDITIONAL_DIRECTORIES_MAX_ITEMS} 项通过，257 项拒绝`, () => {
    const ok = zcodeSessionCreateParamsSchema.parse({
      workspace: validWorkspace,
      additionalDirectories: makePaths(ZCODE_ADDITIONAL_DIRECTORIES_MAX_ITEMS),
    }) as { additionalDirectories: string[] };
    assert.equal(ok.additionalDirectories.length, ZCODE_ADDITIONAL_DIRECTORIES_MAX_ITEMS);

    for (const { name, schema } of schemas) {
      assert.throws(
        () => schema.parse(paramsWith(schema, makePaths(ZCODE_ADDITIONAL_DIRECTORIES_MAX_ITEMS + 1))),
        undefined,
        `${name} 应拒绝 257 项`,
      );
    }
  });

  it("非字符串项拒绝；strict 拒绝未知键", () => {
    for (const { schema } of schemas) {
      assert.throws(() => schema.parse(paramsWith(schema, [42])));
      assert.throws(() =>
        schema.parse({ ...paramsWith(schema, ["/tmp/a"]), unknownKey: true }),
      );
    }
  });
});
