import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.js";

import type { ModelInputMessage } from "@zcode/contracts";

type Msg = ModelInputMessage;

const sys = (content: string): Msg => ({ role: "system", content });
const user = (content: string): Msg => ({ role: "user", content });

describe("normalizeOpenAiCompatibleSystemMessages", () => {
  it("无 system：原样返回", () => {
    const messages = [user("hi")];
    assert.deepEqual(normalizeOpenAiCompatibleSystemMessages(messages), messages);
  });

  it("单个开头 system + 纯 user：原样返回", () => {
    const messages = [sys("base"), user("a"), user("b")];
    assert.deepEqual(normalizeOpenAiCompatibleSystemMessages(messages), messages);
  });

  it("开头多个 system：合并为一个（既有行为保持）", () => {
    const result = normalizeOpenAiCompatibleSystemMessages([
      sys("AAA"),
      sys("BBB"),
      user("x"),
    ]);
    assert.deepEqual(result, [sys("AAABBB"), user("x")]);
  });

  it("中段 system（user 之后）：前移到开头 system 之后（qwen38 后端修复）", () => {
    const result = normalizeOpenAiCompatibleSystemMessages([
      sys("base"),
      user("question"),
      sys("The following skills are available"),
      user("next"),
    ]);
    assert.deepEqual(result, [
      sys("base"),
      sys("The following skills are available"),
      user("question"),
      user("next"),
    ]);
  });

  it("无开头 system 但有中段 system：中段 system 前置到最前", () => {
    const result = normalizeOpenAiCompatibleSystemMessages([
      user("a"),
      sys("mid"),
      user("b"),
    ]);
    assert.deepEqual(result, [sys("mid"), user("a"), user("b")]);
  });

  it("中段连续多条 system：按原顺序全部前移", () => {
    const result = normalizeOpenAiCompatibleSystemMessages([
      user("a"),
      sys("m1"),
      sys("m2"),
      user("b"),
    ]);
    assert.deepEqual(result, [sys("m1"), sys("m2"), user("a"), user("b")]);
  });

  it("开头合并段与中段 system 并存：先合并开头，再按序前移中段", () => {
    const result = normalizeOpenAiCompatibleSystemMessages([
      sys("A"),
      sys("B"),
      user("q"),
      sys("skills-list"),
      user("q2"),
    ]);
    assert.deepEqual(result, [sys("AB"), sys("skills-list"), user("q"), user("q2")]);
  });
});
