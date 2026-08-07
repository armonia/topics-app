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
 *   SHAPE     is the picture in the hero still the reference's picture. This is
 *             the one that ends an argument rather than measuring a property.
 *
 *             Three backgrounds were built and rejected here before this one,
 *             and every rejection sounded the same — "figo, però non ci siamo".
 *             The common cause was that each was INVENTED: built in the spirit
 *             of a reference and then judged by eye, by me. So the reference was
 *             taken apart instead (scripts/landing-field-target.json holds the
 *             numbers and the method), and this budget compares our arch to
 *             theirs: where its peak is, how deep it is, how far the whole curve
 *             sits from theirs, and — the one that every earlier attempt blew —
 *             HOW LITTLE IT MOVES. The reference breathes 10.6 points over a 7s
 *             loop and 0.3 at its edges. It is almost still, and that stillness
 *             is most of what the eye was reading.
 *
 *             Hue is deliberately not compared: theirs is violet, ours is Topics
 *             blue on the page's own ground. What is copied is the composition.
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

/* SHAPE, against scripts/landing-field-target.json. Every tolerance here is
   stated against the reference's own numbers rather than picked:

     apex       the peak may sit an eighth of the frame either side of theirs and
                a tenth of it higher or lower — wider than the peak's own drift
                across their loop, narrow enough that a symmetric arch fails.
     depth      how far the corners sit below the peak. This is the property that
                separates an arch from a horizon; a flat wash reads as 0.
     rms        the whole twelve-point curve, so a shape that hits the peak and
                the corners by accident and misses everything between still
                fails.
     breath     ceiling 0.12 because THEIRS IS 0.106 — a budget tighter than the
                thing it copies is a wrong budget. The floor exists because a
                background frozen solid is also not this one. */
const TARGET = JSON.parse(await readFile(new URL('./landing-field-target.json', import.meta.url), 'utf8'));
const APEX_X_TOL = 0.12;
const APEX_Y_TOL = 0.10;
const DEPTH_TOL = 0.10;
const MAX_RMS = 0.08;
const MAX_BREATH = 0.12;
const MIN_BREATH = 0.004;
/* Half the reference's 7.00s loop apart, so the breath term is at the opposite
   end of its swing and the two frames bracket the full excursion. */
const SHAPE_T = [0.0, 3.5];

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

/* The reference's frames were decoded to 192x144 before anything was measured,
   so each of its sample columns is a box average of 7.5 native ones. Ours is
   reduced to the same 192 columns for the same reason, and it is not cosmetic.
   Measured on the full-resolution shot, one column of 1440 put the crest at the
   top of the frame at x=0 and nowhere else — because LUMINANCE WEIGHS BLUE AT
   0.0722. A picture made of Topics blue has a luminance span of 22/255 where the
   reference's is 240, so the 15% threshold sits three units above the floor,
   which is inside the swing of the CSS grain. The same box filter that smoothed
   theirs divides that noise by the same 7.5, and the two pipelines become one
   pipeline — which is the only way the comparison means anything. */
const SHOT_W = 192;
const SHOT_H = 120;   // 1440x900 reduced by 7.5 in both axes, as theirs was

/**
 * Runs in the page: our own crest curve, extracted exactly the way the
 * reference's was — twelve columns, and in each the y where luminance first
 * reaches 15% of THAT COLUMN's own range, interpolated between the two rows
 * that straddle it.
 *
 * The threshold is a fraction of the column rather than a value because the two
 * pictures are nowhere near the same brightness: the reference averages 104/255
 * and this page's composite caps relative luminance at L 0.036. An absolute
 * threshold would be comparing two different quantities and reporting the
 * difference as a shape.
 */
const CREST = async ([b64, w, h]) => {
  const im = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = 'data:image/png;base64,' + b64;
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(im, 0, 0, w, h);
  const D = x.getImageData(0, 0, w, h).data;
  const L = (px, py) => {
    const i = (py * w + px) * 4;
    return 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
  };
  const out = [];
  for (let k = 0; k < 12; k++) {
    const px = Math.min(w - 1, Math.round((k / 11) * (w - 1)));
    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < h; y++) { const l = L(px, y); if (l < mn) mn = l; if (l > mx) mx = l; }
    const th = mn + 0.15 * (mx - mn);
    let cy = 1;
    for (let y = 0; y < h; y++) {
      if (L(px, y) >= th) {
        if (y === 0) { cy = 0; break; }
        const a = L(px, y - 1), b = L(px, y);
        cy = ((y - 1) + (th - a) / (b - a)) / (h - 1);
        break;
      }
    }
    /* The column's own span comes back with it. A column the light never reaches
       has no crest to find, and the search degenerates to the top of the frame —
       which reads in the report as a wildly wrong arch rather than as the empty
       column it is. Printing the span is what tells those two apart. */
    out.push({ y: +cy.toFixed(4), span: +(mx - mn).toFixed(1) });
  }
  return out;
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

const fails = [];

/* ── SHAPE ────────────────────────────────────────────────────────────────
   In the hero, at scroll 0, which is what "the intro" means: below the hero the
   apex deliberately walks and the arch lifts, because the reference has no
   scroll behaviour at all (its video ends with its hero) and this canvas is
   fixed to the window for 14,081px. */
await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(120);

const shapeShot = async (t) => {
  await page.evaluate((tt) => window.__field.freeze(tt, 0), t);
  await page.waitForTimeout(140);
  return (await page.screenshot({ type: 'png' })).toString('base64');
};
const colsA = await page.evaluate(CREST, [await shapeShot(SHAPE_T[0]), SHOT_W, SHOT_H]);
const colsB = await page.evaluate(CREST, [await shapeShot(SHAPE_T[1]), SHOT_W, SHOT_H]);
const crestA = colsA.map((c) => c.y);
const crestB = colsB.map((c) => c.y);
const spans = colsA.map((c) => c.span);

const wanted = TARGET.crest.mean;
const apexI = crestA.indexOf(Math.min(...crestA));
const shape = {
  apexX: +TARGET.x[apexI].toFixed(4),
  apexY: crestA[apexI],
  depth: +(((crestA[0] + crestA[11]) / 2) - crestA[apexI]).toFixed(4),
  rms: +Math.sqrt(crestA.reduce((s, v, i) => s + (v - wanted[i]) ** 2, 0) / 12).toFixed(4),
  breath: +Math.max(...crestA.map((v, i) => Math.abs(crestB[i] - v))).toFixed(4),
  minSpan: Math.min(...spans),
};

if (Math.abs(shape.apexX - TARGET.apex.x) > APEX_X_TOL) {
  fails.push(`shape: the arch peaks at x ${(shape.apexX * 100).toFixed(0)}% (reference ${(TARGET.apex.x * 100).toFixed(0)}%, ±${APEX_X_TOL * 100}) — that is a different composition, not a variation on it`);
}
if (Math.abs(shape.apexY - TARGET.apex.y) > APEX_Y_TOL) {
  fails.push(`shape: the peak sits at y ${(shape.apexY * 100).toFixed(1)}% (reference ${(TARGET.apex.y * 100).toFixed(1)}%, ±${APEX_Y_TOL * 100})`);
}
if (Math.abs(shape.depth - TARGET.depth) > DEPTH_TOL) {
  fails.push(`shape: the arch is ${(shape.depth * 100).toFixed(1)} points deep against the reference's ${(TARGET.depth * 100).toFixed(1)} (±${DEPTH_TOL * 100}) — ${shape.depth < TARGET.depth ? 'that is a horizon, not an arch' : 'the corners have fallen off the frame'}`);
}
if (shape.rms > MAX_RMS) {
  fails.push(`shape: the curve sits ${(shape.rms * 100).toFixed(1)} points from the reference's on average (max ${MAX_RMS * 100}) — the peak and the corners can be right and the shape between them still wrong`);
}
if (shape.breath > MAX_BREATH) {
  fails.push(`shape: the crest moves ${(shape.breath * 100).toFixed(1)} points across half the loop (max ${MAX_BREATH * 100}, and the reference's own is ${(TARGET.breathMax * 100).toFixed(1)}) — this background is almost still, and three earlier ones were rejected for not being`);
}
if (shape.breath < MIN_BREATH) {
  fails.push(`shape: the crest moves ${(shape.breath * 100).toFixed(2)} points across half the loop (floor ${MIN_BREATH * 100}) — it has stopped breathing, or the time uniform is not reaching the shader`);
}

const rows = [];
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

console.log(`\nthe arch in the hero, against the reference measured in landing-field-target.json\n`);
console.log('  x            ' + TARGET.x.map((v) => pad((v * 100).toFixed(0), 6)).join(''));
console.log('  reference %  ' + TARGET.crest.mean.map((v) => pad((v * 100).toFixed(1), 6)).join(''));
console.log('  ours %       ' + crestA.map((v) => pad((v * 100).toFixed(1), 6)).join(''));
console.log('  difference   ' + crestA.map((v, i) => pad(((v - TARGET.crest.mean[i]) * 100).toFixed(1), 6)).join(''));
console.log('  span /255    ' + spans.map((v) => pad(v.toFixed(0), 6)).join(''));
console.log('');
console.log(`  peak      x ${(shape.apexX * 100).toFixed(0)}%  y ${(shape.apexY * 100).toFixed(1)}%` +
            `        reference  x ${(TARGET.apex.x * 100).toFixed(0)}%  y ${(TARGET.apex.y * 100).toFixed(1)}%`);
console.log(`  depth     ${(shape.depth * 100).toFixed(1)} points` +
            `${' '.repeat(Math.max(1, 16 - (shape.depth * 100).toFixed(1).length))}reference  ${(TARGET.depth * 100).toFixed(1)} points`);
console.log(`  distance  ${(shape.rms * 100).toFixed(1)} points rms` +
            `${' '.repeat(Math.max(1, 12 - (shape.rms * 100).toFixed(1).length))}budget     ${(MAX_RMS * 100).toFixed(0)}`);
console.log(`  breath    ${(shape.breath * 100).toFixed(1)} points / half loop  reference  ${(TARGET.breathMax * 100).toFixed(1)}`);

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
console.log('\n✓ the arch in the hero is the reference\'s, and the field is present everywhere, reads as a glow rather than an edge, and hands the reading column back below the hero');
