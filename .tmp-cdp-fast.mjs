/** 一体化：等调试口出现 → 连上 renderer → 抓 DOM/失败资源/console，然后退出。 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const EXE = "C:\\Users\\YaCHEN\\AppData\\Local\\Programs\\yazcode\\yazcode.exe";
const PORT = 9333;

const app = spawn(EXE, ["--disable-gpu", `--remote-debugging-port=${PORT}`], { stdio: "ignore" });
console.log("app spawned pid=", app.pid);

let targets = null;
for (let i = 0; i < 30; i += 1) {
  await delay(2000);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
    if (targets.some((t) => t.type === "page")) break;
  } catch {
    process.stdout.write(".");
  }
}
if (!targets) {
  console.log("\n调试口始终不可达（进程可能已退出），exit code =", app.exitCode);
  process.exit(1);
}

const page = targets.find((t) => t.type === "page");
console.log("\ntarget:", (page.title ?? "").slice(0, 40), "|", page.url.slice(0, 80));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws error"));
});

const pending = new Map();
const events = [];
let mid = 0;
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) events.push(msg);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++mid;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");
await delay(5000);

const ready = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
console.log("readyState:", ready.result?.result?.value);

const dom = await send("Runtime.evaluate", {
  expression:
    "JSON.stringify({root: !!document.getElementById('root'), rootChildren: document.getElementById('root')?.childElementCount, bodyChildren: document.body.childElementCount, text: document.body.innerText.slice(0,120)})",
  returnByValue: true,
});
console.log("dom:", dom.result?.result?.value);

const failedRes = await send("Runtime.evaluate", {
  expression:
    "JSON.stringify(performance.getEntriesByType('resource').filter(r=>r.responseStatus && r.responseStatus>=300 || r.transferSize===0 && r.decodedBodySize===0).map(r=>r.name.split('/').pop()+':'+r.responseStatus).slice(0,10))",
  returnByValue: true,
});
console.log("failed/empty resources:", failedRes.result?.result?.value);

const scripts = await send("Runtime.evaluate", {
  expression: "JSON.stringify({scripts: document.scripts.length, appEntry: !!document.querySelector('script[type=module]')})",
  returnByValue: true,
});
console.log("scripts:", scripts.result?.result?.value);

console.log("\n--- console/exception/network events ---");
for (const e of events) {
  if (e.method === "Runtime.exceptionThrown") {
    console.log("EXC:", (e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text ?? "").slice(0, 400));
  } else if (e.method === "Log.entryAdded") {
    console.log(`LOG[${e.params.entry.level}]:`, (e.params.entry.text ?? "").slice(0, 300));
  } else if (e.method === "Network.loadingFailed") {
    console.log("NET-FAIL:", e.params.errorText, e.params.type ?? "");
  }
}

ws.close();
app.kill();
process.exit(0);