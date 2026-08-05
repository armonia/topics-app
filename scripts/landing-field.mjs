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

/* ── AND THEN THE PAGE GREW A SECOND GROUND ──────────────────────────────
   The budgets above are the PAPER ones and every word of their reasoning still
   holds — on a near-white sheet anything you can see is dirt. They are also the
   reason this gate quietly stopped working the day the ink bands landed: three
   of its four sample positions became opaque dark bands, `.field` is behind
   them and paints nothing there, and the gate went on reporting a cheerful
   `reading max 0` for a layer that was no longer the layer on screen.

   A ceiling-only gate cannot tell "clean" from "absent". This one has a floor
   for exactly that reason, and the floor passed anyway because the hero still
   showed 11/255 of paper field above the band. So: the floor was right to exist
   and too coarse to catch it.

   The fix is to measure BOTH materials, each where it actually operates, and to
   give the ink one its own budgets — because the ink material is not trying to
   be invisible. On a near-black ground a glow adds light instead of taking
   contrast, so it is ALLOWED in the reading column, and what would be wrong
   there is not presence but violence: a hard edge, a band, a seam. That is a
   ceiling on the peak, not on the coverage.

   Whether the ink field costs any contrast is not guessed here either — it is
   measured directly, on the painted pixels, by `check:painted`. */
/* THE INK BUDGET IS A SMOOTHNESS, NOT A MAGNITUDE, and the first version of it
   got this wrong in the same way this file already warns about for paper: a
   per-pixel maximum cannot tell a hairline from a wash. Ported to ink, "the
   aurora peaks at 73/255" is not a finding — a strong glow and a hard edge have
   the same peak and are opposite designs. What separates them is how much the
   layer changes between ADJACENT pixels: a 52px-blurred radial gradient moves a
   fraction of a step per pixel, a seam or a banded ramp moves many.
   So the ink material is gated on three things and each one gates a failure no
   other gate can see:
     LOCAL STEP  is it a glow or an edge
     FLOOR       is it painting at all
     (contrast)  does it cost legibility — measured exactly, on the painted
                 pixels, by `check:painted`. Not duplicated here with a
                 magnitude ceiling that would only ever be a worse proxy. */
/* MEASURED ON THE AURORA ALONE. The ink material is two layers — a glow and a
   dot grid — and the grid's dots are deliberate 1px marks with hard edges, so a
   smoothness test run over both reported 8/255 and pointed at coordinates that
   were all multiples of 120: the grid pitch, not a defect. The same mistake the
   paper budget above already documents, met from the other side.
   So the ink pass takes three shots instead of two and separates them:
     aurora = full-layer minus dots-hidden   → smoothness AND floor
     dots   = full-layer minus aurora-hidden → floor only, since a 1px mark has
              no smoothness to test and never had. */
const MAX_INK_STEP = 4;        // adjacent-pixel change in the AURORA's contribution
const MIN_INK_PRESENT = 8;     // an aurora you cannot measure is an aurora that is off
const MIN_INK_DOTS = 1;        // the grid has to be painting too

/* The scroll offsets to sample, one set per material, each one inside a single
   ground rather than straddling a seam. Taken from the built page's section map
   — the previous set was written before the long-tail grid moved onto ink, and
   two of its three "paper" samples had drifted onto a seam and a band, which is
   the same way this gate went blind the first time. If the rhythm changes
   again, re-read the map before trusting these:

     ink   58-1192   ·  paper 1550-2916  ·  ink 3155-6104
     paper 6472-7819 ·  ink 8059-12587 */
const SAMPLES = [
  { name: 'model (quiet)', y: 1700, material: 'paper' },
  { name: 'demo (deep)', y: 2100, material: 'paper' },
  { name: 'limits (deep)', y: 6700, material: 'paper' },
  { name: 'hero (ink)', y: 300, material: 'ink' },
  { name: 'acts (ink)', y: 3400, material: 'ink' },
  { name: 'close (ink)', y: 9200, material: 'ink' },
];

/** Which element is the material, per sample. */
const LAYER = { paper: '.field', ink: '.band__field' };

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
  /* The layer's own contribution, per pixel, kept so the local gradient can be
     read off it. A magnitude says how bright; only the gradient says whether it
     is a glow or an edge. */
  const contrib = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < A.length; i += 4, p++) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    contrib[p] = d;
    const x = p % w;
    if (x >= readL && x < readR) {
      if (d > maxRead) maxRead = d;
      sumRead += d; nRead++;
      if (d > VISIBLE) litRead++;
    } else if (d > maxGut) maxGut = d;
  }
  /* The 99.9th percentile rather than the maximum: one row of subpixel
     antialiasing at the very edge of the viewport is not a design defect, and a
     single-pixel outlier is exactly what a max reports. */
  const steps = [];
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const k = y * w + x;
      steps.push(Math.max(Math.abs(contrib[k] - contrib[k + 1]), Math.abs(contrib[k] - contrib[k + w])));
    }
  }
  steps.sort((a, b) => a - b);
  const localStep = steps[Math.floor(steps.length * 0.999)] ?? 0;
  return {
    maxReading: maxRead,
    meanReading: +(sumRead / Math.max(1, nRead)).toFixed(3),
    /* The load-bearing number. A hairline rule at 16/255 and a wash at 16/255
       are the same `max` and completely different designs; what separates them
       is how much of the column is covered. */
    coverReading: +(100 * litRead / Math.max(1, nRead)).toFixed(2),
    maxGutter: maxGut,
    localStep,
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
  const sel = LAYER[s.material];
  /* For ink the CONTENT is hidden for both shots. The aurora sits behind opaque
     screenshots and cards, and every one of their edges is a place where the
     layer's contribution drops to zero in one pixel — which a smoothness test
     would report as an edge in the aurora. `visibility: hidden` leaves the
     layout exactly where it was and removes only the paint. */
  let mask = null, dotsOnly = null;
  if (s.material === 'ink') {
    mask = await page.addStyleTag({ content:
      `.band--ink > *:not(.band__field) { visibility: hidden !important; }` });
    await page.waitForTimeout(90);
  }
  const withField = (await page.screenshot({ type: 'png' })).toString('base64');

  /* The middle shot: the aurora gone, the dot grid still there. */
  let noAurora = null;
  if (s.material === 'ink') {
    dotsOnly = await page.addStyleTag({ content: `.band__field::before { display: none !important; }` });
    await page.waitForTimeout(90);
    noAurora = (await page.screenshot({ type: 'png' })).toString('base64');
    await dotsOnly.evaluate((el) => el.remove());
    await page.waitForTimeout(60);
  }
  await page.evaluate((q) => {
    document.querySelectorAll(q).forEach((e) => (e.style.display = 'none'));
    document.documentElement.classList.add('no-field');
  }, sel);
  await page.waitForTimeout(120);
  const without = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.evaluate((q) => {
    document.querySelectorAll(q).forEach((e) => (e.style.display = ''));
    document.documentElement.classList.remove('no-field');
  }, sel);

  if (mask) { await mask.evaluate((el) => el.remove()); await page.waitForTimeout(60); }

  const d = await page.evaluate(DIFF, [withField, without, WIDTH, HEIGHT]);
  /* For ink the numbers that gate are the AURORA's, taken from the middle shot;
     `d` is kept for the report so the whole layer's magnitude is still visible.
     `aur` compares full against dots-only, which leaves the glow. */
  const aur = noAurora ? await page.evaluate(DIFF, [withField, noAurora, WIDTH, HEIGHT]) : null;
  const dots = noAurora ? await page.evaluate(DIFF, [noAurora, without, WIDTH, HEIGHT]) : null;
  rows.push({ ...s, ...d, aurStep: aur?.localStep, aurMax: aur ? Math.max(aur.maxGutter, aur.maxReading) : undefined,
              dotMax: dots ? Math.max(dots.maxGutter, dots.maxReading) : undefined });

  if (s.material === 'paper') {
    if (d.maxReading > MAX_READING) fails.push(`${s.name}: reading column peaks at ${d.maxReading}/255 (max ${MAX_READING})`);
    if (d.meanReading > MAX_MEAN_READING) fails.push(`${s.name}: reading column averages ${d.meanReading}/255 (max ${MAX_MEAN_READING})`);
    if (d.coverReading > MAX_COVER_READING) fails.push(`${s.name}: field visibly touches ${d.coverReading}% of the reading column (max ${MAX_COVER_READING}%)`);
    if (d.maxGutter > MAX_GUTTER) fails.push(`${s.name}: gutters peak at ${d.maxGutter}/255 (max ${MAX_GUTTER})`);
  } else {
    /* No coverage or magnitude ceiling on ink, and that is the design rather
       than an oversight: the aurora is MEANT to be seen, including behind the
       words, and whether it costs legibility is measured exactly elsewhere.
       What it may not be is abrupt. */
    if (aur && aur.localStep > MAX_INK_STEP) fails.push(`${s.name}: the aurora changes ${aur.localStep}/255 between adjacent pixels (max ${MAX_INK_STEP}) — that is an edge or a band, not a glow`);
    if (dots && Math.max(dots.maxGutter, dots.maxReading) < MIN_INK_DOTS) fails.push(`${s.name}: the dot grid paints nothing (floor ${MIN_INK_DOTS}) — it is off, not subtle`);
  }
}

/* Two floors, one per material, and each on the samples where that material is
   the one on screen. The single floor this gate used to have passed for weeks
   after three of its four samples had stopped measuring anything, because the
   one remaining sliver of paper field above the hero band still cleared it. */
for (const [material, floor] of [['paper', MIN_PRESENT], ['ink', MIN_INK_PRESENT]]) {
  const set = rows.filter((r) => r.material === material);
  if (!set.length) { fails.push(`no sample measures the ${material} material at all`); continue; }
  const best = Math.max(...set.map((r) => (material === 'ink' ? (r.aurMax ?? 0) : Math.max(r.maxGutter, r.maxReading))));
  if (best < floor) {
    fails.push(`the ${material} material paints nothing anywhere it was sampled (best ${best}/255, floor ${floor}) — it is off, not subtle`);
  }
}

await browser.close();
server.close();

console.log(`both field materials measured at ${SAMPLES.length} scroll positions, ${WIDTH}×${HEIGHT}\n`);
console.log('  material  position           reading max   reading mean   reading cover   gutter max   aurora step   dots');
for (const r of rows) {
  console.log(`  ${r.material.padEnd(8)}  ${r.name.padEnd(18)} ${String(r.maxReading).padStart(7)}       ${String(r.meanReading).padStart(8)}       ${(r.coverReading + '%').padStart(8)}     ${String(r.maxGutter).padStart(7)}     ${String(r.aurStep ?? r.localStep).padStart(9)}   ${String(r.dotMax ?? '·').padStart(4)}`);
}
if (!fails.length) {
  console.log(`\n✓ paper: invisible in the reading column (≤${MAX_COVER_READING}% cover, ≤${MAX_MEAN_READING}/255 mean) and present in the gutters`);
  console.log(`✓ ink:   a glow rather than an edge (≤${MAX_INK_STEP}/255 between adjacent pixels) and present`);
  process.exit(0);
}
console.log(`\n✗ ${fails.length} failing:\n`);
for (const f of fails) console.log(`  ${f}`);
process.exit(1);
