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
 * So: boot the built demo, and treat any uncaught error as a failure.
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
import { chromium } from 'playwright-core';

const root = resolve(process.argv[2] || 'landing/dist');

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

let browser;
try {
  browser = await chromium.launch();
} catch {
  // No bundled chromium (playwright-core ships none): use the real Chrome.
  browser = await chromium.launch({ channel: 'chrome' });
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errori = [];
page.on('pageerror', (e) => errori.push(`uncaught: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text().split('\n')[0];
  if (/Failed to load resource/.test(t)) return;   // covered by the response hook
  errori.push(`console: ${t}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && !ATTESI_404.test(r.url())) errori.push(`HTTP ${r.status()} ${r.url()}`);
});

const target = `${base}/app/index.html`;
await page.goto(target, { waitUntil: 'load' });
await page.waitForTimeout(8000);
const testo = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
await browser.close();
server.close();

const problemi = [...errori];
/* «Authorise this device» is the pairing gate: the demo has no server to pair
 * with, so reaching it means the identity mock stopped matching the client. */
if (/Authorise this device|Autorizza questo dispositivo/.test(testo)) {
  problemi.push('the demo stops at the pairing gate — /api/auth/session mock out of date');
}
if (testo.length < 200) problemi.push(`the app rendered almost nothing (${testo.length} chars of text)`);

if (problemi.length) {
  console.error(`check:demo — the demo in ${root}/app does NOT boot clean:`);
  for (const p of [...new Set(problemi)].slice(0, 15)) console.error('  · ' + p);
  console.error('\nThe mocks live in client/src/demo/landing-boot.js. To see which');
  console.error('endpoints fall through to the generic answer, set __DEMO_TRACE__ = true');
  console.error('before the bundle runs and read the [demo] fallback lines in the console.');
  process.exit(1);
}
console.log(`check:demo — the demo boots clean (${testo.length} chars rendered, 0 errors).`);
