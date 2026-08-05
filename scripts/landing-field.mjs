/**
 * Field gate for the landing site.
 *
 *   bun run check:field               # after `cd landing && bun run build`
 *
 * Every other property of this page is measured. The FIELD — the fixed layer
 * behind everything — was the one thing left judged by eye, and it is precisely
 * the thing that got the previous decoration deleted: a noise layer over a cool
 * near-white ground "reads as a dirty display rather than as a material". That
 * failure is a quantity, so it can have a number and a gate.
 *
 * The measurement is a difference, not an absolute. The page is rendered twice,
 * once with the field and once with it hidden, and the two are compared pixel
 * by pixel. That isolates the field's own contribution from the design it sits
 * behind, which is the only thing this gate has an opinion about.
 *
 * ── WHAT THIS FILE USED TO GATE, AND WHY NONE OF IT APPLIES ────────────────
 * It carried two sets of budgets, for two materials, because the page had two
 * grounds: a paper one whose field had to be invisible in the reading column,
 * and an ink one whose glow was allowed to be seen. The page has one ground
 * now, and one surface behind it — a lit WebGL height field driven by scroll —
 * so the paper budgets are deleted rather than relaxed.
 *
 * Keeping them would have been worse than deleting them, and the reason is in
 * this file's own history: when the ink bands landed, three of its four sample
 * positions became opaque dark bands, `.field` painted nothing behind them, and
 * the gate went on cheerfully reporting `reading max 0` for a layer that was no
 * longer the layer on screen. A gate pointed at the wrong element does not
 * fail. It passes, and it keeps passing.
 *
 * ── WHAT IT GATES NOW ──────────────────────────────────────────────────────
 * Three things, and each is a failure no other gate on this page can see. The
 * field is one lit body rendered into a framebuffer plus a composite pass that
 * rolls its luminance off against a ceiling; `window.__field.freeze` pins both
 * at a chosen time and page position, which is what makes any of this
 * reproducible.
 *
 *   PRESENT   the surface has to paint something. If the shader fails to
 *             compile, or a driver refuses a context, `fluid.ts` removes its own
 *             canvas and the page falls back to a CSS aurora — quietly and
 *             correctly, which is exactly why it needs a gate. A page that has
 *             silently lost its background still looks fine in a screenshot.
 *
 *   SMOOTH    is it a glow or an edge. A per-pixel maximum cannot tell those
 *             apart: a strong glow and a hard seam have the same peak and are
 *             opposite designs. What separates them is how much the layer
 *             changes between ADJACENT pixels.
 *
 *   CHANNEL   below the hero, the surface has to be quieter down the middle
 *             than at the flanks. That invariant is what keeps the reading
 *             column legible, it exists in one line of the shader
 *             (`body *= channel`), and nothing else here would notice if it
 *             were deleted. `check:painted` would catch the fallout eventually,
 *             but as fifty contrast failures rather than as "the channel is
 *             gone".
 *
 * Whether the field costs any legibility is NOT re-gated here with a magnitude
 * ceiling that would only ever be a worse proxy: `check:painted` measures it
 * exactly, on the painted pixels, under every text run on the page.
 *
 * No new dependency to decode the PNGs: the screenshots are handed back to the
 * browser as data URIs and diffed on a canvas, which is a decoder already open.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const WIDTH = 1440;
const HEIGHT = 900;

/* Budgets, from the shipped measurements with the headroom stated rather than
   guessed. Never loosen one to make a change pass — the note above about a gate
   pointed at the wrong element is what that costs. */
const MIN_PRESENT = 8;      // /255. Below this the surface is off, not subtle.
const MAX_STEP = 5;         // adjacent-pixel change in the field's contribution
const MAX_CHANNEL = 0.75;   // column mean ÷ gutter mean, below the hero

/* The shader is pinned before every shot. It runs on a rAF loop, so two
   screenshots a frame apart are of two different backgrounds and the diff would
   be measuring the animation rather than the field. `fluid.ts` exposes the
   handle for this and for `check:painted`; if it is missing this run proves
   nothing, and says so instead of passing. */
const FREEZE_T = 7.2;

/* One sample per screen, since the surface is a function of scroll and a single
   position would gate one frame of a film. `hero` is flagged because the
   channel is deliberately CLOSED there: the only things over the middle of the
   first screen are 66px display type and the opaque frame of the app, so that
   is the one place the surface may be brightest down the centre. */
const SAMPLES = [
  { name: 'hero', y: 200, hero: true },
  { name: 'model', y: 1600 },
  { name: 'acts 1-2', y: 3200 },
  { name: 'acts 4-5', y: 5200 },
  { name: 'compare', y: 7000 },
  { name: 'long tail', y: 9000 },
  { name: 'close', y: 11200 },
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

  /* The reading column: the middle third. 62ch of prose at 16px is about 640px
     inside a 1440 viewport, and every measure on this page sits in that band. */
  const readL = Math.round(w * 0.34), readR = Math.round(w * 0.66);
  let peak = 0, sumRead = 0, nRead = 0, sumGut = 0, nGut = 0;
  const contrib = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < A.length; i += 4, p++) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    contrib[p] = d;
    if (d > peak) peak = d;
    const x = p % w;
    if (x >= readL && x < readR) { sumRead += d; nRead++; } else { sumGut += d; nGut++; }
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
  return {
    peak,
    meanRead: +(sumRead / Math.max(1, nRead)).toFixed(3),
    meanGut: +(sumGut / Math.max(1, nGut)).toFixed(3),
    localStep: steps[Math.floor(steps.length * 0.999)] ?? 0,
  };
};

const server = await serve();
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
const page = await ctx.newPage();
await page.goto(server.url + '/v3/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
await page.addStyleTag({ content: `*, *::before, *::after {
  animation-delay: 0s !important; animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important; transition-duration: 0s !important; }
  /* The page scrolls smoothly, which means a scripted scrollTo is still MOVING
     when the first screenshot is taken and has moved further by the second.
     Measured drift across one sample: 2161 → 2605 → 2652 → 2700, so the two
     frames were of different content and the diff reported 249/255 — the
     animation, not the field. */
  html { scroll-behavior: auto !important; }
  /* The content is hidden for every shot. The surface sits behind opaque
     screenshots and cards, and every one of their edges is a place where its
     contribution drops to zero in one pixel — which the smoothness test would
     report as an edge in the field. Hiding by visibility rather than by display
     leaves the layout exactly where it is and removes only the paint. */
  main, header.capsule, .footer, footer { visibility: hidden !important; }` });

if (!(await page.evaluate(() => !!window.__field))) {
  console.error('\n✗ the field never came up.');
  console.error('  `window.__field` is missing, so the shader did not compile, the browser');
  console.error('  refused a context, or fluid.ts stopped exposing the handle. The page');
  console.error('  falls back to a CSS aurora and LOOKS fine, which is why this is a gate.');
  await browser.close(); server.close();
  process.exit(1);
}

const pin = () => page.evaluate((t) => {
  const max = document.documentElement.scrollHeight - innerHeight;
  window.__field.freeze(t, max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0);
}, FREEZE_T);

/** Scroll there, pin the surface, and do not come back until it has stopped. */
const settle = async (y) => {
  await page.evaluate((t) => scrollTo({ top: t, behavior: 'instant' }), y);
  for (let i = 0; i < 30; i++) {
    const a = await page.evaluate(() => Math.round(scrollY));
    await page.waitForTimeout(60);
    const b = await page.evaluate(() => Math.round(scrollY));
    if (a === b) break;
  }
  await pin();
  await page.waitForTimeout(80);
};

const rows = [];
const fails = [];
for (const s of SAMPLES) {
  await settle(s.y);
  const withAll = (await page.screenshot({ type: 'png' })).toString('base64');

  await page.evaluate(() => { document.querySelector('.field').style.display = 'none'; });
  await page.waitForTimeout(90);
  const without = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.evaluate(() => { document.querySelector('.field').style.display = ''; });
  await page.waitForTimeout(70);
  await pin();

  const all = await page.evaluate(DIFF, [withAll, without, WIDTH, HEIGHT]);
  const channel = all.meanGut > 0 ? +(all.meanRead / all.meanGut).toFixed(2) : 0;
  rows.push({ ...s, ...all, step: all.localStep, channel });

  if (all.peak < MIN_PRESENT) {
    fails.push(`${s.name}: the field contributes at most ${all.peak}/255 (floor ${MIN_PRESENT}) — it is off, not subtle`);
  }
  if (all.localStep > MAX_STEP) {
    fails.push(`${s.name}: the surface steps ${all.localStep}/255 between adjacent pixels (max ${MAX_STEP}) — that is an edge, not a glow`);
  }
  if (!s.hero && channel > MAX_CHANNEL) {
    fails.push(`${s.name}: the reading column is ${channel}× the gutters (max ${MAX_CHANNEL}) — the channel that protects the text is not open`);
  }
}

await browser.close();
server.close();

const pad = (v, n) => String(v).padStart(n);
console.log(`\nthe field measured at ${SAMPLES.length} scroll positions, ${WIDTH}×${HEIGHT}, surface pinned at t=${FREEZE_T}\n`);
console.log('  position       peak   column mean   gutter mean   column÷gutter   local step');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(13)}${pad(r.peak, 5)}${pad(r.meanRead, 14)}${pad(r.meanGut, 14)}` +
              `${pad(r.hero ? r.channel + ' (hero)' : r.channel, 16)}${pad(r.step, 13)}`);
}

if (fails.length) {
  console.log(`\n✗ ${fails.length} failing:\n`);
  for (const f of fails) console.log('  ' + f);
  console.log('');
  process.exit(1);
}
console.log('\n✓ the field is present everywhere, reads as a glow rather than an edge, and hands the reading column back below the hero');
