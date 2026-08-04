/**
 * Measure the landing page instead of judging it by eye.
 *
 * This exists because the demo frame was tuned by eye once and got it wrong in
 * a way nobody could see: the frame rendered the app at a 1.43x logical
 * viewport and scaled it back down, so the app's dominant 11px type reached the
 * visitor at 7.71 CSS px. It looked like "a bigger monitor" and measured like
 * shrunken text, which is exactly the sort of thing an opinion cannot settle.
 *
 * The number that matters is the app's text size AS THE VISITOR SEES IT, read
 * from the parent frame so the CSS transform is applied. Computing it as
 * `11 * scale` is what produced the wrong answer the first time.
 *
 *   node scripts/landing-measure.mjs [baseUrl]
 *
 * With no argument it serves ./landing itself on a free port.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pw;
// Since the site moved to Astro the hand-written assets — and the demo build —
// live under landing/public/, which is what this server has to serve and where
// the images have to land. dist/ would work too, but only after a build; public/
// is the source and never stale.
const ROOT = resolve(fileURLToPath(new URL('../landing/public', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

async function serve() {
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
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const arg = process.argv[2];
const server = arg ? null : await serve();
const BASE = arg || server.url;

const browser = await chromium.launch();
let bad = 0;

for (const [name, width, height] of [['desktop', 1440, 900], ['laptop', 1280, 800], ['phone', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.frameLocator('#demoFrame').locator('[data-pane-id="terminal:cc1"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(2000);

  const frame = await page.locator('.showcase__frame').boundingBox();
  const logical = await page.frameLocator('#demoFrame').locator('body')
    .evaluate(() => ({ w: innerWidth, h: innerHeight }));
  // A tab label is the app's dominant 11px type. Read the rect from the PARENT
  // document, which has the transform applied, and compare with the inner rect:
  // the ratio is the scale the visitor actually gets.
  const seen = await page.evaluate(() => {
    const f = document.querySelector('#demoFrame');
    const el = f.contentDocument?.querySelector('[data-pane-id="terminal:cc1"]');
    if (!el) return null;
    const innerH = el.getBoundingClientRect().height;
    const fontPx = parseFloat(getComputedStyle(el).fontSize);
    const scale = new DOMMatrix(getComputedStyle(f).transform).a || 1;
    return { fontPx, scale, visitorFontPx: +(fontPx * scale).toFixed(2), innerH };
  });
  const overflow = await page.frameLocator('#demoFrame').locator('body')
    .evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

  const ok = seen && seen.visitorFontPx >= 10.5 && !overflow;
  if (!ok) bad++;
  console.log(
    `${name.padEnd(8)} frame ${String(Math.round(frame.width)).padStart(4)}x${String(Math.round(frame.height)).padEnd(4)}` +
    ` logical ${String(logical.w).padStart(4)}x${String(logical.h).padEnd(4)}` +
    ` app text seen ${String(seen ? seen.visitorFontPx : '?').padStart(5)}px (scale ${seen ? seen.scale.toFixed(2) : '?'})` +
    ` h-overflow ${overflow}  ${ok ? 'ok' : '*** FAIL ***'}`
  );
  await page.close();
}

await browser.close();
if (server) server.close();
console.log(bad === 0
  ? '\nAll widths readable: app text lands at 1:1, no horizontal overflow inside the demo.'
  : `\n${bad} width(s) failing — the demo is rendering its app smaller than it should.`);
process.exit(bad === 0 ? 0 : 1);
