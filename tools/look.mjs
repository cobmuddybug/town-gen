// Drive headless Chromium over CDP: run JS steps against the dev server and screenshot.
// node tools/look.mjs URL OUT.png ['js step' ...]   (each step may return a promise)
// SIZE=WxH sets the window (default 1500x950); DARK=1 asks for the dark colour scheme;
// LOOK_WAIT=ms waits that long for the page before the first step (default 3000).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, ...steps] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "look-"));
// Distros name it differently (Fedora: chromium-browser); CHROME overrides.
const which = (b) => { try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; } };
const bin = process.env.CHROME ?? ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"].find(which) ?? "chromium";
const [W, H] = (process.env.SIZE ?? "1500x950").split("x").map(Number);
const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
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
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
if (process.env.DARK) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
else await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url });
await sleep(Number(process.env.LOOK_WAIT ?? 3000));
// PROFILE=out.cpuprofile records a CPU profile of the steps (open it in Chrome's DevTools).
if (process.env.PROFILE) { await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 200 }); await send("Profiler.start"); }
for (const s of steps) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${s} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("[step error]", r.result.exceptionDetails.exception?.description);
  else if (r.result?.result?.value !== undefined) console.log("[step]", JSON.stringify(r.result.result.value));
  await sleep(300);
}
if (process.env.PROFILE) writeFileSync(process.env.PROFILE, JSON.stringify((await send("Profiler.stop")).result.profile));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
chrome.kill();
