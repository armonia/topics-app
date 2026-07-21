// Footprint: cold startup-to-CDP-ready + RSS (whole process tree) at blank / example.com / wikipedia.
// Usage: node footprint.mjs <engineKey> [port]
import { launch, CDP, newPageSession, treeRssMB, sleep, now } from "./lib/cdp.mjs";

const engineKey = process.argv[2] || "headless-shell";
const port = +(process.argv[3] || 9333);

async function loadAndSettle(sess, browser, url) {
  await sess.send("Page.enable");
  const loaded = new Promise((res) => {
    const to = setTimeout(res, 12000);
    sess.on("Page.loadEventFired", () => { clearTimeout(to); res(); });
  });
  await sess.send("Page.navigate", { url });
  await loaded;
  await sleep(1500); // let subresources + memory settle
}

// Wrap a flat session id into a CDP-like sender.
function bind(browser, sessionId) {
  return {
    send: (m, p) => browser.send(m, p, sessionId),
    on: (m, h) => browser.on(m, (params) => h(params)),
  };
}

const main = async () => {
  const b = await launch(engineKey, port);
  const result = { engine: engineKey, startupMs: b.startupMs };
  try {
    const browser = await CDP.connect(b.wsUrl);
    const { sessionId } = await newPageSession(browser);
    const sess = bind(browser, sessionId);

    await sleep(800);
    result.rssBlankMB = treeRssMB(b.proc.pid);

    await loadAndSettle(sess, browser, "https://example.com");
    result.rssExampleMB = treeRssMB(b.proc.pid);

    await loadAndSettle(sess, browser, "https://en.wikipedia.org/wiki/Chromium");
    result.rssWikipediaMB = treeRssMB(b.proc.pid);

    browser.close();
  } finally {
    b.dispose();
  }
  console.log(JSON.stringify(result));
};

main().catch((e) => { console.log(JSON.stringify({ engine: engineKey, error: String(e.message || e) })); process.exit(0); });
