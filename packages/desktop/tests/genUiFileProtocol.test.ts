import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGenUiFileProtocol } from "../src/main/genUi/genUiFileProtocol.js";
import { GEN_UI_HTML_MAX_BYTES } from "@zcode/shared/gen-ui";

// 主进程是 gen-ui 的唯一授权点（spec 验收场景 3）：这里的测试把协议处理器接到临时
// 输出根上，逐条打安全校验——越界、符号链接、类型、体积、文件名与 URL 形状。

interface CapturedHandler {
  (request: { url: string }): Promise<Response> | Response;
}

const createdRoots: string[] = [];

function makeRoot(prefix = "gen-ui-proto-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

function setup(root: string): CapturedHandler {
  let handler: CapturedHandler | undefined;
  installGenUiFileProtocol(
    {
      handle(_scheme, registered) {
        handler = registered as CapturedHandler;
      },
    },
    { getOutputRoot: () => root },
  );
  return handler!;
}

async function respond(root: string, path: string): Promise<Response> {
  return setup(root)({ url: `gen-ui://local/file?path=${encodeURIComponent(path)}` });
}

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

test.after(() => {
  // Windows 句柄延迟可能让删除失败；尽力清理，不影响断言结果。
  for (const root of createdRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
});

test("valid fragment is served with height bridge and scrollbar style injected", async () => {
  const root = makeRoot();
  const file = join(root, "week-calendar.html");
  writeFileSync(file, "<html><head><title>t</title></head><body>hi</body></html>");
  const response = await respond(root, file);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  const body = await bodyOf(response);
  assert.match(body, /zcode:gen-ui-size/);
  assert.match(body, /zcode-gen-ui-document-scrollbar/);
  // 桥脚本注入在 <head> 之后、作者脚本之前（先于作者代码执行）。
  const bridgeAt = body.indexOf("zcode-gen-ui-height-bridge");
  const headAt = body.indexOf("<head>");
  const titleAt = body.indexOf("<title>");
  assert.ok(headAt < bridgeAt && bridgeAt < titleAt);
});

test("bridge is prepended when the fragment has no <head>", async () => {
  const root = makeRoot();
  const file = join(root, "bare.html");
  writeFileSync(file, "<body>hi</body>");
  const body = await bodyOf(await respond(root, file));
  assert.ok(body.startsWith("<style"));
  assert.match(body, /zcode:gen-ui-size/);
});

test("path escaping the output root is rejected", async () => {
  const root = makeRoot();
  const outside = makeRoot("gen-ui-outside-");
  const file = join(outside, "evil.html");
  writeFileSync(file, "<p>x</p>");
  const body = await bodyOf(await respond(root, file));
  assert.match(body, /未通过安全校验/);
});

test("literal parent traversal (..) in the wire path is rejected", async () => {
  const root = makeRoot();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "ok.html"), "<p>x</p>");
  // 手拼原始字符串：Node 的 join 会把 .. 词法归一掉，而模型可能原样发出带 .. 的路径，
  // wire schema 必须在它到达 realpath 之前拒掉。
  const rawTraversal = `${root}${root.endsWith("\\") ? "" : "\\"}sub\\..\\ok.html`;
  const body = await bodyOf(await respond(root, rawTraversal));
  assert.match(body, /可视化源文件不可用|未通过安全校验/);
});

test("symbolic link segments inside the root are rejected", async (t) => {
  const root = makeRoot();
  const targetDir = makeRoot("gen-ui-target-");
  const realFile = join(targetDir, "real.html");
  writeFileSync(realFile, "<p>x</p>");
  const link = join(root, "linked.html");
  try {
    symlinkSync(realFile, link, "file");
  } catch (error) {
    t.skip(`symlink unavailable on this host: ${String(error)}`);
    return;
  }
  const body = await bodyOf(await respond(root, link));
  assert.match(body, /未通过安全校验/);
});

test("symlinked root itself resolves (only segments under the root are guarded)", async (t) => {
  const realRoot = makeRoot("gen-ui-realroot-");
  const linkRoot = makeRoot("gen-ui-linkroot-");
  try {
    symlinkSync(realRoot, linkRoot, "dir");
  } catch (error) {
    t.skip(`symlink unavailable on this host: ${String(error)}`);
    return;
  }
  const file = join(realRoot, "via-link.html");
  writeFileSync(file, "<p>x</p>");
  const body = await bodyOf(await respond(linkRoot, file));
  assert.match(body, /zcode:gen-ui-size/);
});

test("directories and non-conforming filenames are rejected", async () => {
  const root = makeRoot();
  mkdirSync(join(root, "sub.html"));
  writeFileSync(join(root, "notes.txt"), "CONTENT-notes");
  writeFileSync(join(root, "Bad.html"), "CONTENT-bad");
  writeFileSync(join(root, "bad_name.html"), "CONTENT-underscore");
  // 错误页也注入桥脚本，不能用 zcode:gen-ui-size 区分成败；以原文内容是否被送达为准。
  for (const candidate of ["sub.html", "notes.txt", "Bad.html", "bad_name.html"]) {
    const body = await bodyOf(await respond(root, join(root, candidate)));
    assert.match(body, /⚠/, candidate);
    assert.doesNotMatch(body, /CONTENT-/, candidate);
  }
});

test("oversized fragments are rejected at stat and re-checked after read", async () => {
  const root = makeRoot();
  const file = join(root, "big.html");
  writeFileSync(file, "<p>" + "x".repeat(GEN_UI_HTML_MAX_BYTES) + "</p>");
  const body = await bodyOf(await respond(root, file));
  assert.match(body, /未通过安全校验/);
});

test("malformed protocol URLs are rejected before any filesystem access", async () => {
  const root = makeRoot();
  const handler = setup(root);
  // 主机名/路径形状不对 → Invalid URL；URL 合法但缺 path 参数 → wire schema 拒绝 → 不可用页。
  for (const url of ["gen-ui://evil/file?path=x.html", "gen-ui://local/other?path=x.html"]) {
    const body = await bodyOf(await handler({ url }));
    assert.match(body, /Invalid Gen UI URL\./, url);
  }
  const missingPath = await bodyOf(await handler({ url: "gen-ui://local/file" }));
  assert.match(missingPath, /可视化源文件不可用/);
});

test("missing file degrades to a non-crashing error page", async () => {
  const root = makeRoot();
  const body = await bodyOf(await respond(root, join(root, "gone.html")));
  assert.match(body, /可视化源文件不可用/);
});
