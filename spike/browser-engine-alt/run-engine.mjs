import { launch, CDP, newPage, treeRssMB, sleep, now } from "./bench.mjs";
import { writeFileSync, appendFileSync } from "node:fs";

const SITES = [
  ["blank", "about:blank"],
  ["example", "https://example.com"],
  ["hn", "https://news.ycombinator.com"],
  ["wikipedia", "https://en.wikipedia.org/wiki/Web_browser"],
  ["github", "https://github.com/topics/browser"],
  ["react-app", "https://react.dev"],
];

const engine = process.argv[2];
const port = +(process.argv[3] || 9500);
const out = process.argv[4] || "results.jsonl";

function log(o) { appendFileSync(out, JSON.stringify({ engine, ...o }) + "\n"); console.log(JSON.stringify({ engine, ...o })); }

const b = await launch(engine, port);
log({ phase: "startup", startupMs: b.startupMs, product: b.info.Browser || b.info.product || null });
await sleep(500);
log({ phase: "rss-idle", ...treeRssMB(b.proc.pid) });

const browser = await CDP.connect(b.wsUrl);
let sess;
try {
  const p = await newPage(browser);
  sess = p.sessionId;
} catch (e) {
  log({ phase: "newPage", error: String(e.message) });
}

// capability probe
const caps = {};
for (const m of ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Emulation.setDeviceMetricsOverride", "Input.dispatchMouseEvent"]) {
  try {
    const params = m === "Emulation.setDeviceMetricsOverride" ? { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
      : m === "Input.dispatchMouseEvent" ? { type: "mouseMoved", x: 10, y: 10 } : {};
    await browser.send(m, params, sess);
    caps[m] = true;
  } catch (e) { caps[m] = String(e.message).slice(0, 80); }
}
log({ phase: "caps", caps });

for (const [name, url] of SITES) {
  try {
    const t0 = now();
    await browser.send("Page.navigate", { url }, sess);
    // attendi load event o timeout
    let loaded = false;
    const onLoad = () => { loaded = true; };
    browser.on("Page.loadEventFired", onLoad);
    const dl = now() + 15000;
    while (now() < dl && !loaded) await sleep(25);
    const navMs = +(now() - t0).toFixed(0);
    await sleep(700);
    const rss = treeRssMB(b.proc.pid);
    let title = null, textLen = null, domNodes = null;
    try {
      const r = await browser.send("Runtime.evaluate", { expression: "[document.title, document.body?document.body.innerText.length:0, document.querySelectorAll('*').length].join('|')", returnByValue: true }, sess);
      const v = String(r.result?.value ?? "");
      [title, textLen, domNodes] = v.split("|");
    } catch (e) { title = "ERR:" + String(e.message).slice(0, 60); }
    let shotMs = null, shotKB = null;
    try {
      const s0 = now();
      const s = await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sess);
      shotMs = +(now() - s0).toFixed(0);
      shotKB = +((s.data.length * 0.75) / 1024).toFixed(1);
    } catch (e) { shotMs = "ERR:" + String(e.message).slice(0, 60); }
    log({ phase: "site", site: name, navMs, loaded, rssMB: rss.mb, procs: rss.procs, title, textLen: +textLen, domNodes: +domNodes, shotMs, shotKB });
  } catch (e) {
    log({ phase: "site", site: name, error: String(e.message).slice(0, 150) });
  }
}

// screencast test
try {
  let frames = 0, bytes = 0;
  browser.on("Page.screencastFrame", (p) => {
    frames++; bytes += p.data.length * 0.75;
    browser.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sess).catch(() => {});
  });
  await browser.send("Page.navigate", { url: "https://en.wikipedia.org/wiki/Web_browser" }, sess);
  await sleep(1500);
  await browser.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 }, sess);
  await browser.send("Runtime.evaluate", { expression: "(()=>{let d=document.createElement('div');d.style.cssText='position:fixed;inset:0;background:red;z-index:9999';document.body.appendChild(d);let i=0;setInterval(()=>{d.style.background=`hsl(${i=(i+7)%360},80%,50%)`},16);return 1})()" }, sess);
  await sleep(5000);
  await browser.send("Page.stopScreencast", {}, sess).catch(() => {});
  log({ phase: "screencast", frames, fps: +(frames / 5).toFixed(1), kbPerFrame: frames ? +(bytes / frames / 1024).toFixed(1) : 0 });
} catch (e) {
  log({ phase: "screencast", error: String(e.message).slice(0, 150) });
}

// input RTT
try {
  await browser.send("Runtime.evaluate", { expression: "window.__hits=0;document.addEventListener('mousedown',()=>window.__hits++,true);1" }, sess);
  const rtts = [];
  for (let i = 0; i < 10; i++) {
    const t0 = now();
    await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 }, sess);
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 100, button: "left", clickCount: 1 }, sess);
    const r = await browser.send("Runtime.evaluate", { expression: "window.__hits", returnByValue: true }, sess);
    rtts.push(now() - t0);
    if (i === 9) log({ phase: "input", hits: r.result?.value, p50: +rtts.sort((a, c) => a - c)[5].toFixed(2), avg: +(rtts.reduce((a, c) => a + c) / rtts.length).toFixed(2) });
  }
} catch (e) { log({ phase: "input", error: String(e.message).slice(0, 150) }); }

browser.close();
b.dispose();
process.exit(0);
