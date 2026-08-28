// Records the PROOF clip for "the window empties when the server restarts".
//
// Driven by the Rust test `demo_window_recovers_after_server_restart`, which owns
// the timeline: it serves a fake app through the SHIPPED proxy loop, kills the
// upstream mid-clip, then brings it back. This script is only the camera + the
// browser: it opens the page, reloads while the server is DOWN (the exact move
// that used to leave the window permanently empty), and waits for the app to come
// back on its own. Exits non-zero if it doesn't.
//
//   node window-recovery-demo.mjs <proxyPort> <outDir>

import { chromium } from 'playwright-core';

const [, , portArg, outDir] = process.argv;
const url = `http://127.0.0.1:${portArg}/`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 900, height: 560 },
  recordVideo: { dir: outDir, size: { width: 900, height: 560 } },
});
const page = await context.newPage();

const shot = async (label) => {
  const text = (await page.textContent('body').catch(() => '')) || '';
  console.log(`[demo] ${label}: ${text.trim().slice(0, 60)}`);
  return text;
};

// t≈0 — the app, served through the proxy.
await page.goto(url, { waitUntil: 'domcontentloaded' });
const live = await shot('app viva');
if (!live.includes('TOPICS')) throw new Error('the app never loaded through the proxy');
await page.waitForTimeout(3500);

// t≈3.5s — the server is down by now (the Rust side killed it at t=3s). Reload:
// this is the move that used to kill the window for good.
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
const down = await shot('server giu');
if (!down.includes('Waiting for the server')) {
  throw new Error(`expected the reconnect page, got: ${down.slice(0, 80)}`);
}
await page.waitForTimeout(1200);

// t≈9s the Rust side restarts the upstream. Nobody touches the browser from here:
// the reconnect page must bring the app back BY ITSELF.
await page.waitForFunction(
  () => document.body && document.body.innerText.includes('TOPICS'),
  null,
  { timeout: 20000 },
);
await shot('tornata da sola');
await page.waitForTimeout(1500);

await context.close();
await browser.close();
console.log('[demo] OK');
