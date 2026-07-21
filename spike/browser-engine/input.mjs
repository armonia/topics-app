// Input latency: CDP Input.dispatch* round-trip, confirmed by reading DOM state back.
// Usage: node input.mjs <engineKey> [port] [iterations]
import { launch, CDP, newPageSession, sleep, now } from "./lib/cdp.mjs";

const engineKey = process.argv[2] || "headless-shell";
const port = +(process.argv[3] || 9335);
const ITERS = +(process.argv[4] || 30);

const PAGE = `data:text/html,<!doctype html><meta charset=utf-8>
<input id=i style="position:absolute;left:40px;top:40px;width:400px;height:40px;font-size:20px">
<script>window.__clicks=0;document.getElementById('i').addEventListener('click',()=>window.__clicks++);</script>`;

function bind(browser, sessionId) {
  return { send: (m, p) => browser.send(m, p, sessionId), on: (m, h) => browser.on(m, h) };
}
const evalJs = async (sess, expression) => (await sess.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

const main = async () => {
  const b = await launch(engineKey, port);
  const result = { engine: engineKey };
  try {
    const browser = await CDP.connect(b.wsUrl);
    const { sessionId } = await newPageSession(browser);
    const sess = bind(browser, sessionId);
    await sess.send("Page.enable");
    await sess.send("Runtime.enable");
    const loaded = new Promise((res) => { const to = setTimeout(res, 6000); sess.on("Page.loadEventFired", () => { clearTimeout(to); res(); }); });
    await sess.send("Page.navigate", { url: PAGE });
    await loaded;
    await sleep(300);

    // --- Mouse click round-trip (dispatch -> confirm __clicks incremented) ---
    const clickRtts = [];
    for (let k = 0; k < ITERS; k++) {
      const t = now();
      await sess.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 60, button: "left", clickCount: 1 });
      await sess.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 120, y: 60, button: "left", clickCount: 1 });
      // poll until the click handler observed it
      let got = false;
      while (now() - t < 1000) { if ((await evalJs(sess, "window.__clicks")) >= k + 1) { got = true; break; } }
      if (got) clickRtts.push(now() - t);
    }

    // focus the field
    await sess.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 60, button: "left", clickCount: 1 });
    await sess.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 120, y: 60, button: "left", clickCount: 1 });
    await evalJs(sess, "document.getElementById('i').focus()");

    // --- Key round-trip: insertText one char, confirm value.length grew ---
    const keyRtts = [];
    for (let k = 0; k < ITERS; k++) {
      const t = now();
      await sess.send("Input.insertText", { text: "a" });
      let got = false;
      while (now() - t < 1000) { if ((await evalJs(sess, "document.getElementById('i').value.length")) >= k + 1) { got = true; break; } }
      if (got) keyRtts.push(now() - t);
    }

    const stat = (a) => a.length ? {
      n: a.length,
      avgMs: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2),
      p50Ms: +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2),
      maxMs: +Math.max(...a).toFixed(2),
    } : { n: 0 };
    result.mouseClick = stat(clickRtts);
    result.keyInsert = stat(keyRtts);
    result.finalValueLen = await evalJs(sess, "document.getElementById('i').value.length");

    browser.close();
  } finally {
    b.dispose();
  }
  console.log(JSON.stringify(result));
};

main().catch((e) => { console.log(JSON.stringify({ engine: engineKey, error: String(e.message || e) })); process.exit(0); });
