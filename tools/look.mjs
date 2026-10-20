// Drive headless Chromium over CDP: run JS steps against the dev server and screenshot.
// node tools/look.mjs URL OUT.png ['js step' ...]   (each step may return a promise)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, ...steps] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "look-"));
const chrome = spawn("chromium", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--window-size=1500,950", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") console.log("[console]", msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Runtime.exceptionThrown") console.log("[exception]", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(Number(process.env.LOOK_WAIT ?? 3000));
for (const s of steps) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${s} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("[step error]", r.result.exceptionDetails.exception?.description);
  else if (r.result?.result?.value !== undefined) console.log("[step]", JSON.stringify(r.result.result.value));
  await sleep(300);
}
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
chrome.kill();
