/**
 * 通过 CDP 连 yazcode 的 renderer，读取真实状态：
 * document 内容、console 消息、未捕获异常、失败的网络请求。
 * 用 Node 22+ 内置 WebSocket（workwin 无 ws 依赖）。
 */
const PORT = process.env.CDP_PORT ?? "9333";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let id = 0;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        events,
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error("WS error: " + (e.message ?? "?")));
  });
}

const targets = await listTargets();
const page = targets.find((t) => t.type === "page" && /yazcode|zcode|index\.html|localhost/i.test(t.url))
  ?? targets.find((t) => t.type === "page");
if (!page) {
  console.log("no page target; all targets:", targets.map((t) => `${t.type}:${t.url.slice(0, 60)}`));
  process.exit(1);
}
console.log("target:", page.title?.slice(0, 40), "|", page.url.slice(0, 80));

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Network.enable");
await sleep(4000);

console.log("\n== readyState / DOM ==\n");
const state = await cdp.send("Runtime.evaluate", { expression: "document.readyState" });
console.log("readyState:", state.result?.value);
const root = await cdp.send("Runtime.evaluate", {
  expression: "document.getElementById('root') ? 'root exists, children=' + document.getElementById('root').childElementCount : 'NO #root'; document.body.childElementCount",
  returnByValue: true,
});
console.log("root:", JSON.stringify(root.result?.value));
const html = await cdp.send("Runtime.evaluate", {
  expression: "document.body.innerHTML.slice(0, 500)",
  returnByValue: true,
});
console.log("body html:", (html.result?.value ?? "").slice(0, 400));

console.log("\n== console / exceptions（最近 30 条）==\n");
for (const e of cdp.events.slice(-30)) {
  if (e.method === "Runtime.exceptionThrown") {
    const d = e.params.exceptionDetails;
    console.log("EXC:", (d.exception?.description ?? d.text ?? "").slice(0, 300));
  } else if (e.method === "Log.entryAdded") {
    const entry = e.params.entry;
    console.log(`LOG[${entry.level}]:`, (entry.text ?? "").slice(0, 260), entry.url ? `(${entry.url.slice(0, 60)})` : "");
  } else if (e.method === "Network.loadingFailed") {
    console.log("NET-FAIL:", e.params.errorText, e.params.blockedReason ?? "");
  }
}

cdp.close();
process.exit(0);