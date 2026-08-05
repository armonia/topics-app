/**
 * Field gate for the landing site.
 *
 *   bun run check:field               # after `cd landing && bun run build`
 *
 * Every other property of this page is measured. The FIELD — the fixed layer
 * behind everything, made of a lattice canvas, an accent wash and a grain — was
 * the one thing left judged by eye, and it is precisely the thing that got the
 * previous decoration deleted: a noise layer over a cool near-white ground
 * "reads as a dirty display rather than as a material". That failure is a
 * quantity, so it can have a number and a gate.
 *
 * The measurement is a difference, not an absolute. The page is rendered twice,
 * once with the field and once with it hidden, and the two are compared pixel
 * by pixel. That isolates the field's own contribution from the design it sits
 * behind, which is the only thing this gate has an opinion about.
 *
 * Two ceilings and one floor, because the field can fail in both directions:
 *
 *   READING COLUMN   the middle 46% of the viewport, where the text lives. The
 *                    grain is masked away from here on purpose, so the budget
 *                    is tight: this is the "dirty display" number.
 *   GUTTERS          the outer thirds, where the field is allowed to be seen.
 *                    Still capped: a background that competes with a screenshot
 *                    is the other documented way this went wrong.
 *   PRESENT          the field must actually change something, or a stylesheet
 *                    that silently stopped painting it would pass as "very
 *                    subtle" — the failure mode a ceiling-only gate cannot see.
 *
 * No new dependency to decode the PNGs: the screenshots are handed back to the
 * browser as data URIs and diffed on a canvas, which is a decoder that is
 * already open.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const WIDTH = 1440;
const HEIGHT = 900;

/* Set from the SHIPPED measurements, with headroom stated rather than guessed.
   Measured today, worst of the four samples:
     reading max 15   ·   reading mean 0.38   ·   reading cover 0%   ·   gutter max 34
   Tighten these when the field is deliberately quietened — they were tightened
   once already, after this gate caught the wash bleeding into the column and it
   was masked back. Never loosen one to make a change pass.
   The peak in the reading column is the lattice's quarter rule — a deliberate
   1px line at alpha .032-.055, documented in v3.css's contrast-order invariant.
   A per-pixel max cannot tell that hairline apart from a wash of the same
   strength, which is why COVERAGE is the number that actually gates dirtiness
   and the max is only a coarse backstop. */
const MAX_READING = 20;        // a 1px rule may reach here; a wash may not
const MAX_MEAN_READING = 0.8;  // the "dirty display" number
const MAX_COVER_READING = 0.4; // % of the reading column the field may touch visibly
const MAX_GUTTER = 44;         // the gutters are where the field is allowed to be seen
const MIN_PRESENT = 1.5;       // the field has to do SOMETHING

/* The scroll offsets to sample. One in each declared field state, so a change
   that only misbehaves in `dense` cannot hide behind a quiet section. */
const SAMPLES = [
  { name: 'hero (dense)', y: 0 },
  { name: 'model (quiet)', y: 1200 },
  { name: 'act 1 (dense)', y: 2700 },
  { name: 'limits (deep)', y: 6400 },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
                '.webp': 'image/webp', '.svg': 'image/svg+xml', '.xml': 'application/xml' };

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

/** Runs in the page: decode both shots onto canvases and diff them. */
const DIFF = async ([aB64, bB64, w, h]) => {
  const load = (b64) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = 'data:image/png;base64,' + b64;
  });
  const [ia, ib] = await Promise.all([load(aB64), load(bB64)]);
  const px = (im) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data;
  };
  const A = px(ia), B = px(ib);

  /* The reading column is where the grain is masked to nothing and the text
     sits. Its bounds match the mask stops in v3.css (34%..66%). */
  const readL = Math.round(w * 0.34), readR = Math.round(w * 0.66);
  const VISIBLE = 6;   // below this a single pixel is not something anyone sees
  let maxRead = 0, sumRead = 0, nRead = 0, litRead = 0, maxGut = 0;
  for (let i = 0, p = 0; i < A.length; i += 4, p++) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    const x = p % w;
    if (x >= readL && x < readR) {
      if (d > maxRead) maxRead = d;
      sumRead += d; nRead++;
      if (d > VISIBLE) litRead++;
    } else if (d > maxGut) maxGut = d;
  }
  return {
    maxReading: maxRead,
    meanReading: +(sumRead / Math.max(1, nRead)).toFixed(3),
    /* The load-bearing number. A hairline rule at 16/255 and a wash at 16/255
       are the same `max` and completely different designs; what separates them
       is how much of the column is covered. */
    coverReading: +(100 * litRead / Math.max(1, nRead)).toFixed(2),
    maxGutter: maxGut,
  };
};

const server = await serve();
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
const page = await ctx.newPage();
await page.goto(server.url + '/v3/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
/* Settle animations, and stop the lattice repainting between the two shots —
   a diff against a moving target measures the animation, not the field. */
await page.addStyleTag({ content: `*, *::before, *::after {
  animation-delay: 0s !important; animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important; transition-duration: 0s !important; }
  /* The page scrolls smoothly, which means a scripted scrollTo is still MOVING
     when the first screenshot is taken and has moved further by the second.
     Measured drift across one sample: 2161 → 2605 → 2652 → 2700, so the two
     frames were of different content and the diff was reporting 249/255 —
     the animation, not the field. */
  html { scroll-behavior: auto !important; }` });

/** Scroll there and do not come back until the page has actually stopped. */
const settle = async (y) => {
  await page.evaluate((t) => scrollTo({ top: t, behavior: 'instant' }), y);
  for (let i = 0; i < 30; i++) {
    const a = await page.evaluate(() => Math.round(scrollY));
    await page.waitForTimeout(60);
    const b = await page.evaluate(() => Math.round(scrollY));
    if (a === b) return b;
  }
  throw new Error(`scroll never settled at ${y}`);
};

const rows = [];
const fails = [];
for (const s of SAMPLES) {
  await settle(s.y);
  await page.waitForTimeout(400);          // let the field's state observer crossfade
  const withField = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.evaluate(() => {
    document.querySelectorAll('.field').forEach((e) => (e.style.display = 'none'));
    document.documentElement.classList.add('no-field');
  });
  await page.waitForTimeout(120);
  const without = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.evaluate(() => {
    document.querySelectorAll('.field').forEach((e) => (e.style.display = ''));
    document.documentElement.classList.remove('no-field');
  });

  const d = await page.evaluate(DIFF, [withField, without, WIDTH, HEIGHT]);
  rows.push({ ...s, ...d });
  if (d.maxReading > MAX_READING) fails.push(`${s.name}: reading column peaks at ${d.maxReading}/255 (max ${MAX_READING})`);
  if (d.meanReading > MAX_MEAN_READING) fails.push(`${s.name}: reading column averages ${d.meanReading}/255 (max ${MAX_MEAN_READING})`);
  if (d.coverReading > MAX_COVER_READING) fails.push(`${s.name}: field visibly touches ${d.coverReading}% of the reading column (max ${MAX_COVER_READING}%)`);
  if (d.maxGutter > MAX_GUTTER) fails.push(`${s.name}: gutters peak at ${d.maxGutter}/255 (max ${MAX_GUTTER})`);
}

/* The floor is checked once, on the state that declares the field at full
   strength — `deep` sections turn the lattice off on purpose. */
const dense = rows.filter((r) => /dense/.test(r.name));
if (dense.length && !dense.some((r) => r.maxGutter >= MIN_PRESENT)) {
  fails.push(`the field paints nothing in any dense section (max ${Math.max(...dense.map((r) => r.maxGutter))}/255, floor ${MIN_PRESENT}) — it is off, not subtle`);
}

await browser.close();
server.close();

console.log(`field measured at ${SAMPLES.length} scroll positions, ${WIDTH}×${HEIGHT}\n`);
console.log('  position           reading max   reading mean   reading cover   gutter max');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(18)} ${String(r.maxReading).padStart(7)}       ${String(r.meanReading).padStart(8)}       ${(r.coverReading + '%').padStart(8)}     ${String(r.maxGutter).padStart(7)}`);
}
if (!fails.length) {
  console.log(`\n✓ the field touches at most ${MAX_COVER_READING}% of the reading column, averages under ${MAX_MEAN_READING}/255 there, stays under ${MAX_GUTTER}/255 in the gutters, and is actually painting`);
  process.exit(0);
}
console.log(`\n✗ ${fails.length} failing:\n`);
for (const f of fails) console.log(`  ${f}`);
process.exit(1);
