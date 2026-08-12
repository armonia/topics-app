// Unified per-engine benchmark driven through Playwright's launcher + CDP session.
// Needed because the full Chrome-for-Testing build does NOT bind a TCP
// --remote-debugging-port in this env (macOS 26 / build 148); Playwright drives it
// over a pipe. headless-shell works with either transport (see footprint.mjs for the
// raw --remote-debugging-port path). Measurements themselves are pure CDP.
//
// Usage: node pw-bench.mjs <engineKey>   (chromium-headless | headless-shell | chromium-headful)
// Specificatore NUDO, non un percorso assoluto. Era
// `/Users/<nome>/Projects/topics-app/node_modules/playwright-core/index.js`:
// due difetti in una riga — il file girava solo sulla macchina di chi l'ha
// scritto (e solo finché il repo restava in quella cartella), e scriveva il
// nome utente dentro un repo pubblico. `playwright-core` è una dipendenza
// dichiarata della radice, quindi la risoluzione di Node la trova risalendo i
// `node_modules` da qui: è la stessa libreria, presa nel modo che vale ovunque.
import pkg from "playwright-core";
const { chromium } = pkg;
import { treeRssMB, now, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ANIM = "file://" + join(__dir, "assets", "anim.html");
const PW = process.env.HOME + "/Library/Caches/ms-playwright";
const FULL = PW + "/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SHELL = PW + "/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const CONFIGS = {
  "chromium-headless": { executablePath: FULL, headless: true, args: ["--headless=new"] },
  "headless-shell": { executablePath: SHELL, headless: true },
  "chromium-headful": { executablePath: FULL, headless: false },
};

const engineKey = process.argv[2] || "headless-shell";
const cfg = CONFIGS[engineKey];
const DUR = +(process.argv[3] || 5000);

async function settle(page, url) { await page.goto(url, { waitUntil: "load", timeout: 15000 }).catch(() => {}); await sleep(1200); }

const main = async () => {
  const result = { engine: engineKey };
  const t0 = now();
  const server = await chromium.launchServer({ ...cfg, args: [...(cfg.args || [])] });
  const pid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }); // CDP round-trip → "ready"
  result.startupMs = +(now() - t0).toFixed(1);

  try {
    // ---- Footprint (RSS over whole process tree) ----
    await page.goto("about:blank").catch(() => {});
    await sleep(800);
    result.rssBlankMB = treeRssMB(pid).mb;
    await settle(page, "https://example.com");
    result.rssExampleMB = treeRssMB(pid).mb;
    await settle(page, "https://en.wikipedia.org/wiki/Chromium");
    result.rssWikipediaMB = treeRssMB(pid).mb;
    result.procs = treeRssMB(pid).procs;

    // ---- Screencast throughput ----
    await settle(page, ANIM);
    let frames = 0, bytes = 0, firstAt = 0, lastAt = 0;
    cdp.on("Page.screencastFrame", async (p) => {
      const t = now(); if (!firstAt) firstAt = t; lastAt = t;
      frames++; bytes += Buffer.byteLength(p.data, "base64");
      try { await cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch {}
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 });
    await sleep(DUR);
    await cdp.send("Page.stopScreencast").catch(() => {});
    const span = (lastAt - firstAt) / 1000 || DUR / 1000;
    result.screencast = { frames, fps: +(frames / span).toFixed(1), avgFrameKB: frames ? +((bytes / frames) / 1024).toFixed(1) : 0, totalMB: +(bytes / 1048576).toFixed(2) };

    // ---- captureScreenshot loop ----
    let shots = 0, shotBytes = 0; const capEnd = now() + DUR;
    while (now() < capEnd) { const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }); shots++; shotBytes += Buffer.byteLength(r.data, "base64"); }
    result.captureScreenshot = { shots, fps: +(shots / (DUR / 1000)).toFixed(1), avgFrameKB: shots ? +((shotBytes / shots) / 1024).toFixed(1) : 0 };

    // ---- Input latency ----
    await page.setContent(`<input id=i style="position:absolute;left:40px;top:40px;width:400px;height:40px;font-size:20px"><script>window.__c=0;i.addEventListener('click',()=>window.__c++)</script>`);
    await sleep(200);
    const evalv = async (e) => (await cdp.send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
    const N = 30;
    const clickR = [], keyR = [];
    for (let k = 0; k < N; k++) {
      const t = now();
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 60, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 120, y: 60, button: "left", clickCount: 1 });
      while (now() - t < 1000) { if ((await evalv("window.__c")) >= k + 1) break; }
      clickR.push(now() - t);
    }
    await evalv("document.getElementById('i').focus()");
    for (let k = 0; k < N; k++) {
      const t = now();
      await cdp.send("Input.insertText", { text: "a" });
      while (now() - t < 1000) { if ((await evalv("document.getElementById('i').value.length")) >= k + 1) break; }
      keyR.push(now() - t);
    }
    const stat = (a) => ({ n: a.length, avgMs: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2), p50Ms: +a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(2), maxMs: +Math.max(...a).toFixed(2) });
    result.mouseClick = stat(clickR);
    result.keyInsert = stat(keyR);
    result.finalValueLen = await evalv("document.getElementById('i').value.length");
  } catch (e) {
    result.error = String(e.message || e);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  console.log(JSON.stringify(result));
  process.exit(0);
};
main().catch((e) => { console.log(JSON.stringify({ engine: engineKey, error: String(e.message || e) })); process.exit(0); });
