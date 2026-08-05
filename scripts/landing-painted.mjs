/**
 * The painted-backdrop gate.
 *
 *   bun run check:painted            # after `cd landing && bun run build`
 *
 * `check:contrast` computes a ratio by walking each text node's ANCESTORS and
 * compositing their background colours. That model is right for a page made of
 * nested boxes, and this page stopped being one the day it grew an ink ground:
 * the aurora is a blurred pseudo-element on an absolutely-positioned SIBLING of
 * the content, so an ancestor walk cannot see it at all. Every heading on a
 * dark band is measured against #0a0d14 while the screen may be painting
 * #0a0d14 plus thirty percent of a blue glow.
 *
 * That matters in one direction only, and it is the bad one: a glow RAISES the
 * backdrop's luminance, and the text on ink is light, so every photon the
 * aurora adds comes out of the contrast budget.
 *
 * This is the same shape of defect as the one the contrast gate itself had
 * before it learned about ancestor opacity — it reported 6.14:1 for text that
 * painted 1.98:1 — and the lesson is the same. A gate that measures a MODEL of
 * the page can only ever be as right as the model. So this one measures the
 * page: it screenshots with every glyph turned transparent, which leaves every
 * background, overlay, image and blur exactly where it was, and reads the real
 * pixels under each text rectangle off a canvas.
 *
 * It is deliberately not merged into check:contrast. That gate walks nine pages
 * at two widths and answers "is the palette legal"; this one walks one page and
 * answers "is the palette what the screen shows". Two questions, two answers,
 * and when they disagree the disagreement is the finding.
 *
 * No new dependency to decode the PNGs: the screenshot goes back into the page
 * as a data URI and is read off a canvas, which is a decoder already open.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const PAGE = '/v3/';
const WIDTHS = [1440, 390];
const VH = 900;

/* EVERY animation is settled, always. The first version left them running for
   the "aurora start" phase and caught `.limits__cta` at opacity 0 in the middle
   of its own entrance, then graded the paragraph's declared colour against a
   backdrop that had a half-faded paragraph in it. A gate that screenshots a
   transition is measuring the transition.
   `animation-duration: 0s` with `both` holds the TO state, which for `.reveal`
   is the shipped one. */
const SETTLE = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important; transition-delay: 0s !important; }
  html { scroll-behavior: auto !important; }`;

const PHASES = [
  { name: 'field t=0.6', freeze: [0.6] },
  { name: 'field t=9.3', freeze: [9.3] },
  { name: 'pointer centred', freeze: [9.3, 'centre'] },
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

/** In the page: every text run currently on screen, with its rect and its ink. */
const COLLECT = () => {
  const parse = (c) => {
    const m = String(c).match(/[\d.]+/g);
    if (!m) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
  };
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el) continue;
    /* aria-hidden text is decoration; a screen reader never gets it and a
       reader who can see it is reading the glyph beside it. */
    if (el.closest('[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    /* A gradient-filled headline paints no solid colour; check:contrast
       resolves those from the gradient stops and this gate cannot, so it says
       so rather than inventing a number. */
    if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.color === 'rgba(0, 0, 0, 0)') continue;
    /* Fold every ancestor's opacity into the ink, the lesson the other gate
       already learned the hard way. */
    let vis = 1;
    for (let a = el; a; a = a.parentElement) vis *= Number(getComputedStyle(a).opacity);
    if (vis < 0.06) continue;
    const col = parse(cs.color);
    if (!col) continue;

    /* THE LINE BOXES OF THIS TEXT NODE, not the element's bounding box.
       `<p class="limits__cta">Still the right shape for you?<a class="btn">…</a></p>`
       is one element whose box contains a near-black button, and grading the
       paragraph's grey against the pixels inside that button reported 2.42:1
       for a sentence that is nowhere near it. A Range over the text node itself
       returns only the boxes the run actually occupies, so a child element's
       glyphs are never attributed to its parent's colour. */
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      out.push({
        x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
        w: Math.round(Math.min(r.right, innerWidth) - Math.max(0, r.left)),
        h: Math.round(Math.min(r.bottom, innerHeight) - Math.max(0, r.top)),
        col, alpha: col.a * vis,
        size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400,
        onInk: !!el.closest('[data-ground="dark"]'),
        tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        text: (n.nodeValue.trim().slice(0, 44)),
      });
    }
  }
  return out;
};

/**
 * In the page: find the backdrop UNDER THE GLYPHS and grade it.
 *
 * The first version of this took the worst pixel anywhere inside the text
 * rectangle, and it was wrong in a way worth keeping written down. A line box
 * is not made only of letters: `<span class="fg__st">` contains a status pip,
 * `.hero__badge` contains a live dot, `.pick__row` contains a coloured chip.
 * The worst pixel in those rectangles is the DECORATION, which no glyph is ever
 * drawn on top of, and the gate duly reported 1.10:1 for text that is perfectly
 * legible. Seven of its first nine findings were that mistake.
 *
 * The exact answer is a difference. Shot A has the glyphs, shot B has them
 * turned transparent and nothing else changed; the pixels that differ between
 * them ARE the glyphs, antialiasing included. So the backdrop under the text is
 * B sampled at exactly the coordinates where A and B disagree — pips, chips and
 * icons drop out by construction, because they are identical in both.
 */
const SAMPLE = async ([aB64, bB64, w, h, rects]) => {
  const load = (b64) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = rej;
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
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

  /* A glyph pixel has to differ by more than antialiasing noise, or every soft
     edge in the page joins the sample. 24/255 is comfortably above the 1-2 of
     compression and below the weakest real stroke on this page. */
  const GLYPH = 24;

  /* Translucent ink is graded as WCAG grades it: composited over what is behind
     it. `t.alpha` already carries the colour's own alpha times every ancestor
     opacity, so this is the one place both have to be spent. */
  const over = (fg, a, bg) => ({
    r: fg.r * a + bg[0] * (1 - a),
    g: fg.g * a + bg[1] * (1 - a),
    b: fg.b * a + bg[2] * (1 - a),
  });

  return rects.map((t) => {
    let worst = Infinity, worstPx = null, n = 0;
    const x1 = Math.min(w, t.x + t.w), y1 = Math.min(h, t.y + t.h);
    for (let y = t.y; y < y1; y++) {
      for (let x = t.x; x < x1; x++) {
        const k = (y * w + x) * 4;
        const d = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]));
        if (d <= GLYPH) continue;              // not a glyph pixel: pip, icon, rule, background
        n++;
        const back = [B[k], B[k + 1], B[k + 2]];
        const ink = t.alpha >= 1 ? t.col : over(t.col, t.alpha, back);
        const inkL = L(ink.r, ink.g, ink.b);
        const bl = L(back[0], back[1], back[2]);
        const hi = Math.max(inkL, bl), lo = Math.min(inkL, bl);
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < worst) { worst = ratio; worstPx = [B[k], B[k + 1], B[k + 2]]; }
      }
    }
    /* Fewer than a handful of glyph pixels means the run is clipped, covered or
       off-screen — there is nothing to grade, and inventing a number for it is
       how a gate earns a reputation for crying wolf. */
    if (n < 12) return { ...t, ratio: null, bg: null, glyphPx: n };
    return { ...t, ratio: +worst.toFixed(2), bg: worstPx, glyphPx: n };
  });
};

const server = await serve();
const browser = await pw.chromium.launch();

const fails = [];
let checked = 0, onInk = 0;
const worstByPhase = [];

for (const width of WIDTHS) {
  for (const phase of PHASES) {
    const ctx = await browser.newContext({ viewport: { width, height: VH } });
    const page = await ctx.newPage();
    await page.goto(server.url + PAGE, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
    await page.addStyleTag({ content: SETTLE });
    /* The surface is pinned before anything is sampled, and re-pinned after
       every scroll below — scrolling does not restart the loop, but a resize or
       a late first frame can, and a gate that silently un-pins itself is worse
       than no gate. */
    const pin = async () => page.evaluate(([t, mode, w, h]) => {
      const f = window.__field;
      if (!f) return false;
      const max = document.documentElement.scrollHeight - innerHeight;
      const at = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
      f.freeze(t, at, mode === 'centre' ? [w / 2, h / 2] : undefined);
      return true;
    }, [phase.freeze[0], phase.freeze[1] ?? null, width, VH]);
    if (!(await pin())) {
      console.error('\n✗ the field never came up — nothing to grade the text against.');
      console.error('  `window.__field` is missing, so either WebGL failed in this browser or');
      console.error('  fluid.ts stopped exposing the handle. Either way this run proves nothing.');
      process.exit(1);
    }

    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    let phaseWorst = { ratio: Infinity };

    for (let y = 0; y < H - VH; y += VH) {
      await page.evaluate((t) => scrollTo({ top: t, behavior: 'instant' }), y);
      await page.waitForTimeout(220);
      await pin();
      const rects = await page.evaluate(COLLECT);
      if (!rects.length) continue;

      /* Shot A: the page as it is. */
      const withText = (await page.screenshot({ type: 'png' })).toString('base64');

      /* Shot B: every glyph transparent and NOTHING else touched. Backgrounds,
         images, overlays, blurs and blend modes all stay exactly where they
         were, so the difference between the two shots is the type and only the
         type. */
      const hider = await page.addStyleTag({ content: `*, *::before, *::after {
        color: transparent !important; -webkit-text-fill-color: transparent !important;
        text-shadow: none !important; text-decoration-color: transparent !important;
        caret-color: transparent !important; }` });
      await page.waitForTimeout(60);
      const without = (await page.screenshot({ type: 'png' })).toString('base64');
      /* Remove the handle we were given rather than "the last element in head",
         which is only the same thing until something else appends to head. */
      await hider.evaluate((el) => el.remove());

      const sampled = await page.evaluate(SAMPLE, [withText, without, width, VH, rects]);
      for (const s of sampled) {
        if (s.ratio === null) continue;        // clipped or covered: nothing painted to grade
        checked++;
        if (s.onInk) onInk++;
        const large = s.size >= 24 || (s.size >= 18.66 && s.weight >= 700);
        const need = large ? 3 : 4.5;
        if (s.ratio < phaseWorst.ratio) phaseWorst = { ...s, need, width, phase: phase.name };
        if (s.ratio < need) {
          fails.push({ ...s, need, width, phase: phase.name, y });
        }
      }
    }
    worstByPhase.push({ width, phase: phase.name, ...phaseWorst });
    await ctx.close();
  }
}

await browser.close();
server.close();

const rgb = (c) => (c ? `rgb(${c.join(' ')})` : '?');
console.log(`${checked} text runs sampled against the PAINTED backdrop on ${PAGE} (${onInk} of them on the ink ground)`);
console.log(`across ${WIDTHS.length} widths × ${PHASES.length} pinned field frames\n`);
console.log('  width  phase          tightest ratio  needs   element');
for (const w of worstByPhase) {
  console.log(`  ${String(w.width).padStart(5)}  ${w.phase.padEnd(13)} ${String(w.ratio).padStart(9)}:1 ${String(w.need).padStart(9)}   ${w.tag}`);
}

if (!fails.length) {
  console.log(`\n✓ every text run clears AA against the pixels actually painted behind it — the field adds light without spending contrast`);
  process.exit(0);
}

/* One line per element, worst first, deduped: the same heading failing at both
   widths and both phases is one defect, not four. */
const byKey = new Map();
for (const f of fails) {
  const k = f.tag + '|' + f.text;
  if (!byKey.has(k) || byKey.get(k).ratio > f.ratio) byKey.set(k, f);
}
const uniq = [...byKey.values()].sort((a, b) => a.ratio - b.ratio);
console.log(`\n✗ ${uniq.length} elements fail against the painted backdrop:\n`);
for (const f of uniq.slice(0, 40)) {
  console.log(`  ${String(f.ratio).padStart(6)}:1 (needs ${f.need})  ${f.tag}  @${f.width} · ${f.phase} · y${f.y}`);
  console.log(`          rgb(${f.col.r} ${f.col.g} ${f.col.b}) on ${rgb(f.bg)} · ${f.size}px/${f.weight}${f.onInk ? ' · ink ground' : ''}`);
  console.log(`          ${JSON.stringify(f.text)}`);
}
if (uniq.length > 40) console.log(`  … and ${uniq.length - 40} more`);
process.exit(1);
