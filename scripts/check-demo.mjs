#!/usr/bin/env node
/**
 * The landing demo has to BOOT, and only a browser can say so.
 *
 * The demo under /app/ is the real Topics client with a mock seam
 * (client/src/demo/landing-boot.js) standing in for the server. The client
 * moves; the seam does not move with it, and nothing in a build fails when a
 * mock's shape stops matching the code that reads it — the bundle compiles
 * perfectly and then dies at render. That is exactly what had happened while
 * the demo sat committed in git: the snapshot predated the pairing gate, so a
 * rebuild showed "Authorise this device" instead of the app, and ScriptRunner
 * threw on a `scripts` map that had become a list.
 *
 * So: boot the built demo, open the identity menu, and treat any uncaught
 * error as a failure.
 *
 *   bun run check:demo            # after build:site — reads landing/dist/app
 *   bun run check:demo -- <dir>   # any directory containing app/index.html
 *
 * It is wired into `deploy:landing` ahead of wrangler, because a demo that
 * throws is worse than a demo that is a few commits old: the visitor sees a
 * blank rectangle where the product's only live proof should be.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright-core';
import { glassProblems } from './demo-glass-probe.mjs';

const root = resolve(process.argv[2] || 'landing/dist');
/* `--mutant` paints every menu 72% translucent with no blur and expects the
 * glass probe to go red: proof the probe can see the defect it guards against.
 * Its selector is heavier than the demo's solid-fill sheet so it overrides it. */
const MUTANT = process.argv.includes('--mutant');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

/* Image 404s the shim cannot answer: <img src="/api/projects/icon?…"> is not a
 * fetch, so window.fetch never sees it. The app already falls back to a letter
 * tile, which is what the demo shows — noise, not a fault. */
const ATTESI_404 = /\/api\/projects\/icon\b/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file = join(root, decodeURIComponent(url.pathname));
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

/* Launch is bounded on every path. Playwright's own default is 180 s per
 * launch, so a machine with no usable browser used to sit here for up to six
 * minutes (bundled Chromium, then the real Chrome) before saying anything. */
const LAUNCH_TIMEOUT = 30000;

async function launchChromium() {
  try {
    return await chromium.launch({ timeout: LAUNCH_TIMEOUT });
  } catch (bundledErr) {
    // No bundled chromium (playwright-core ships none): use the real Chrome.
    try {
      return await chromium.launch({ channel: 'chrome', timeout: LAUNCH_TIMEOUT });
    } catch (chromeErr) {
      server.close();
      console.error('check:demo — no browser could be launched:');
      console.error('  · bundled chromium: ' + String(bundledErr.message).split('\n')[0]);
      console.error('  · chrome channel:   ' + String(chromeErr.message).split('\n')[0]);
      process.exit(1);
    }
  }
}

/* The demo is a public landing: it has to look right in Safari too, and WebKit
 * resolves stylesheets and backdrop-filter by its own rules. The glass probe
 * once passed on Chromium alone while the menu stayed see-through in WebKit. */
async function launchWebkit() {
  try {
    return await webkit.launch({ timeout: LAUNCH_TIMEOUT });
  } catch (err) {
    server.close();
    console.error('check:demo — WebKit could not be launched (npx playwright install webkit):');
    console.error('  · ' + String(err.message).split('\n')[0]);
    process.exit(1);
  }
}

const target = `${base}/app/index.html`;
const problemi = [];
const errori = [];
let testo = '';   // first engine's text, for the boot summary line only

/** Boots the demo in one engine, opens the identity menu and runs the glass probe. */
async function runEngine(engine, browser) {
  const tag = (m) => (engine === 'chromium' ? m : `[${engine}] ${m}`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errori.push(tag(`uncaught: ${e.message}`)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().split('\n')[0];
    // Any remount makes the demo terminal replay its canned frames; xterm warns
    // about the multi-byte glyph it re-reads mid-sequence. The replay is
    // timer-driven, so on a loaded runner the warning lands at any moment, also
    // before the glass probe (main 7f6ee8f6d, first attempt). It is noise from
    // the canned frames, not a boot fault: uncaught errors still fail here.
    if (/xterm\.js: Parsing error/.test(t)) return;
    if (/Failed to load resource/.test(t)) return;   // covered by the response hook
    // WebKit's own notes about the page, not faults of the demo: an unknown
    // viewport key, and the notification permission asked outside a gesture.
    if (engine === 'webkit' && /Viewport argument key "interactive-widget"|Notification prompting can only be done from a user gesture/.test(t)) return;
    errori.push(tag(`console: ${t}`));
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !ATTESI_404.test(r.url())) errori.push(tag(`HTTP ${r.status()} ${r.url()}`));
  });

  // One retry: on a loaded machine the first navigation can time out before the
  // bundle is even served. A second failure is reported against its engine
  // instead of escaping as an anonymous uncaught exception.
  let reached = false;
  for (let attempt = 0; attempt < 2 && !reached; attempt++) {
    reached = await page.goto(target, { waitUntil: 'load', timeout: 45000 }).then(() => true, (e) => {
      if (attempt === 1) problemi.push(tag(`loading the demo failed twice: ${String(e.message).split('\n')[0]}`));
      return false;
    });
  }
  if (!reached) return;
  await page.waitForTimeout(8000);
  // An explicit 20 s cap instead of Playwright's default (30 s in 1.59): a page
  // that has not drawn its text by then fails, with the reason on its own line.
  const t = (await page.locator('body').innerText({ timeout: 20000 }).catch((e) => {
    problemi.push(tag(`reading the page text failed after at most 20 s: ${String(e.message).split('\n')[0]}`));
    return '';
  })).replace(/\s+/g, ' ').trim();
  testo = testo || t;
  // Every engine answers for itself: an empty or gated page in one engine must
  // not hide behind the text the other engine drew.
  /* «Authorise this device» is the pairing gate: the demo has no server to pair
   * with, so reaching it means the identity mock stopped matching the client. */
  if (/Authorise this device|Autorizza questo dispositivo/.test(t)) {
    problemi.push(tag('the demo stops at the pairing gate — /api/auth/session mock out of date'));
  }
  if (t.length < 200) {
    problemi.push(tag(`the app rendered almost nothing (${t.length} chars of text)`));
    return;
  }
  // The boot alone does not read every mock: the identity band's menu asks for
  // the address book and the friendships, and threw on `[]` while the boot
  // stayed clean. "This Mac" is the device name the /api/auth/session mock gives.
  const identityRow = page.getByRole('button', { name: 'This Mac' }).first();
  // The defect itself: a 72% translucent menu whose backdrop is not blurred.
  if (MUTANT) await page.addStyleTag({ content: 'html .glass-surface.glass-surface.glass-surface{background-color:rgb(237 239 243 / .72) !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}' });
  if (await identityRow.click({ timeout: 10000 }).then(() => true, () => false)) {
    await page.waitForTimeout(2500);
    const glass = (await glassProblems(page, browser)).map(tag);
    await page.waitForTimeout(3000);
    if (MUTANT) {
      if (!glass.length) problemi.push(tag('mutant survived: with an unblurred translucent menu the glass probe stayed green'));
      else console.log(`check:demo --mutant (${engine}) — the glass probe went red as it should`);
    } else problemi.push(...glass);
  } else {
    problemi.push(tag('the identity row («This Mac») is not drawn, so its menu could not be opened'));
  }
}

try {
  for (const [engine, launch] of [['chromium', launchChromium], ['webkit', launchWebkit]]) {
    const browser = await launch();
    try {
      await runEngine(engine, browser);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}

problemi.unshift(...errori);
if (problemi.length) {
  console.error(`check:demo — the demo in ${root}/app does NOT boot clean:`);
  for (const p of [...new Set(problemi)].slice(0, 15)) console.error('  · ' + p);
  console.error('\nThe mocks live in client/src/demo/landing-boot.js. To see which');
  console.error('endpoints fall through to the generic answer, set __DEMO_TRACE__ = true');
  console.error('before the bundle runs and read the [demo] fallback lines in the console.');
  process.exit(1);
}
console.log(`check:demo — the demo boots clean (${testo.length} chars rendered, 0 errors).`);
