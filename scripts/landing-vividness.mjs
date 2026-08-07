/**
 * The blandness diagnostic. Not a gate — a number to argue with.
 *
 *   bun run landing:vividness          # after `cd landing && bun run build`
 *
 * "Insipido" and "figo però non ci siamo" are not properties a build can check,
 * but they turned out to have a proxy that tracks them well enough to steer by:
 * how much of each screen is DARK, and how much of it is COLOURED. The second is
 * the useful one — a page can be perfectly on-palette and still read as grey,
 * because a hue at low saturation is a hue nobody sees.
 *
 * VIVID means a channel span (max − min of r,g,b) over 70/255. On a near-black
 * ground that threshold separates "there is a blue here" from "there is a dark
 * pixel here" better than saturation does, because saturation is undefined-ish
 * near black and jumps around on exactly the pixels this page is made of.
 *
 * Reference points, all measured this way:
 *   ai-solutions (the reference)   3.70% vivid
 *   /v3 before the arch            0.37% vivid, 16.1% dark
 *
 * The field is pinned before every shot for the same reason the gates pin it: a
 * screenshot of a rAF loop is a screenshot of a moment nobody can reproduce.
 *
 * Not to be confused with `landing-measure.mjs`, which measures something else
 * entirely — the size the app's own type reaches the visitor at inside the demo.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const OUT = resolve(fileURLToPath(new URL('../landing/.shots', import.meta.url)));
const WIDTH = 1440;
const HEIGHT = 900;
const FREEZE_T = 7.2;

/* One per screen the page actually has, plus the two that decide the first
   impression: the hero, and the screen right after the fold. */
const YS = [0, 900, 1800, 3200, 5200, 7000, 9000, 11200, 13100];
const KEEP = new Set([0, 900, 5200]);   // written to disk, to look at

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.xml': 'application/xml',
  '.woff2': 'font/woff2',
};

const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

/** Runs in the page: dark coverage and vivid coverage of one screenshot. */
const COUNT = async ([b64, w, h]) => {
  const im = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = 'data:image/png;base64,' + b64;
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  const D = x.getImageData(0, 0, w, h).data;
  let dark = 0, vivid = 0, n = 0;
  for (let i = 0; i < D.length; i += 4) {
    const r = D[i], g = D[i + 1], b = D[i + 2];
    n++;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < 70) dark++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 70) vivid++;
  }
  return [(100 * dark) / n, (100 * vivid) / n];
};

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.goto(base + '/v3/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
await page.addStyleTag({ content: `*, *::before, *::after {
  animation-duration: 0s !important; transition-duration: 0s !important; }
  html { scroll-behavior: auto !important; }` });
await page.waitForTimeout(1200);

if (!(await page.evaluate(() => !!window.__field))) {
  console.error('\n✗ the field never came up — this run would measure the CSS fallback.');
  await browser.close(); srv.close();
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const rows = [];
for (const y of YS) {
  await page.evaluate((t) => scrollTo({ top: t, behavior: 'instant' }), y);
  await page.waitForTimeout(300);
  await page.evaluate((t) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.__field.freeze(t, max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0);
  }, FREEZE_T);
  await page.waitForTimeout(140);
  const buf = await page.screenshot({ type: 'png' });
  if (KEEP.has(y)) await writeFile(join(OUT, `v3-y${y}.png`), buf);
  rows.push([y, ...(await page.evaluate(COUNT, [buf.toString('base64'), WIDTH, HEIGHT]))]);
}

await browser.close();
srv.close();

const pad = (v, n) => String(v).padStart(n);
console.log(`\n/v3 measured at ${YS.length} scroll positions, ${WIDTH}×${HEIGHT}, field pinned at t=${FREEZE_T}\n`);
console.log('  scroll y      dark %    vivid %');
for (const [y, d, v] of rows) console.log(`  ${pad(y, 8)}${pad(d.toFixed(1), 12)}${pad(v.toFixed(1), 11)}`);
const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
console.log(`  ${pad('mean', 8)}${pad(mean(1).toFixed(1), 12)}${pad(mean(2).toFixed(1), 11)}`);
console.log(`\n  for comparison: ai-solutions itself measures 3.70% vivid, and this page`);
console.log(`  measured 0.37% vivid and 16.1% dark before any of this work.`);
console.log(`\n  ${KEEP.size} screens written to landing/.shots/`);
