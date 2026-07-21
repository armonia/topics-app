// Screencast throughput/latency vs captureScreenshot loop.
// Usage: node screencast.mjs <engineKey> [port] [durationMs]
import { launch, CDP, newPageSession, sleep, now } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const engineKey = process.argv[2] || "headless-shell";
const port = +(process.argv[3] || 9334);
const DUR = +(process.argv[4] || 5000);
const ANIM = "file://" + join(__dir, "assets", "anim.html");

function bind(browser, sessionId) {
  return {
    send: (m, p) => browser.send(m, p, sessionId),
    on: (m, h) => browser.on(m, h),
  };
}

const main = async () => {
  const b = await launch(engineKey, port);
  const result = { engine: engineKey };
  try {
    const browser = await CDP.connect(b.wsUrl);
    const { sessionId } = await newPageSession(browser);
    const sess = bind(browser, sessionId);
    await sess.send("Page.enable");
    const loaded = new Promise((res) => { const to = setTimeout(res, 8000); sess.on("Page.loadEventFired", () => { clearTimeout(to); res(); }); });
    await sess.send("Page.navigate", { url: ANIM });
    await loaded;
    await sleep(500);

    // --- Page.startScreencast (jpeg, everyNthFrame:1) ---
    let frames = 0, bytes = 0, firstAt = 0, lastAt = 0;
    sess.on("Page.screencastFrame", async (p) => {
      const t = now();
      if (!firstAt) firstAt = t;
      lastAt = t;
      frames++;
      bytes += Buffer.byteLength(p.data, "base64");
      // must ack or the stream stalls
      try { await sess.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch {}
    });
    await sess.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 });
    await sleep(DUR);
    await sess.send("Page.stopScreencast");
    const span = (lastAt - firstAt) / 1000 || DUR / 1000;
    result.screencast = {
      frames,
      fps: +(frames / span).toFixed(1),
      avgFrameKB: frames ? +((bytes / frames) / 1024).toFixed(1) : 0,
      totalMB: +(bytes / 1048576).toFixed(2),
    };

    await sleep(300);

    // --- captureScreenshot loop (serial) ---
    let shots = 0, shotBytes = 0;
    const capEnd = now() + DUR;
    while (now() < capEnd) {
      const r = await sess.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      shots++; shotBytes += Buffer.byteLength(r.data, "base64");
    }
    result.captureScreenshot = {
      shots,
      fps: +(shots / (DUR / 1000)).toFixed(1),
      avgFrameKB: shots ? +((shotBytes / shots) / 1024).toFixed(1) : 0,
    };

    browser.close();
  } finally {
    b.dispose();
  }
  console.log(JSON.stringify(result));
};

main().catch((e) => { console.log(JSON.stringify({ engine: engineKey, error: String(e.message || e) })); process.exit(0); });
