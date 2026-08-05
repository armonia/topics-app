/**
 * Contrast gate for the landing site.
 *
 *   bun run check:contrast            # after `cd landing && bun run build`
 *
 * Reads the BUILT pages in a real browser and measures every text node against
 * the colour actually painted behind it, rather than against the colour the
 * stylesheet says should be there. Those differ constantly — an ancestor with a
 * background, a token that resolves differently inside a dark island, a rule
 * that only applies under a media query.
 *
 * Two checks, and the second is the one a generic a11y tool does not do:
 *
 *   1. WCAG contrast — 4.5:1 for body text, 3:1 for large text (≥24px, or
 *      ≥18.66px bold). This overlaps with axe and is here so the gate is
 *      self-contained and runs without a browser extension.
 *   2. The lightness rule — no READING text above L 56% in OKLCH on paper. On
 *      an L 98 sheet that is exactly where 4.5:1 runs out, so it is the same
 *      constraint stated as a property of the palette instead of as a property
 *      of one pairing. It is what stops a new token being added at L 60 and
 *      passing by accident on a darker card while failing on the page.
 *
 * Text inside a dark island (screenshots, code blocks, the demo frame) is
 * measured against ITS surface, which is what the ancestor walk finds, so the
 * rule inverts there without a special case.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const PAGES = ['/', '/v3/', '/changelog/', '/privacy/', '/blog/', '/wiki/', '/wiki/pty/',
               '/compare/claude-code-guis/', '/blog/electron-vs-tauri-memory-measured/'];
const WIDTHS = [1440, 390];
const MAX_READING_L = 56;

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

/** Runs in the page: walk every text node, find its painted background. */
const PROBE = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const mix = (a, b, t) => ({          // t of a, (1-t) of b
    r: a.r * t + b.r * (1 - t),
    g: a.g * t + b.g * (1 - t),
    b: a.b * t + b.b * (1 - t),
    a: 1,
  });

  /* What is ACTUALLY painted, root → element, folding in every layer on the
     way. The chain is read once and reused by both passes — walking it is the
     expensive part. `inner` is the text colour on the foreground pass and null
     on the background pass; nothing else differs between the two.

     ANCESTOR `opacity` used to be ignored here entirely, and that was a hole
     big enough to hide a real failure: a scene's dimmed context layer reported
     6.14:1 while what actually reached the glass was 1.98:1. An opacity group
     composites as a unit — the text inside it and the background inside it are
     BOTH blended by the same α over whatever lies outside the group — so the
     honest model is to carry α down the chain and apply it to both passes.
     That is also why α is not simply folded into the text's own alpha: doing
     that fades the text toward its background instead of toward the page, and
     reports a dimmed group as less legible than it actually is. */
  const chainOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      chain.push({ bg: parse(cs.backgroundColor), op: Number(cs.opacity) });
    }
    return chain;
  };
  const composite = (chain, inner) => {
    let base = { r: 255, g: 255, b: 255, a: 1 };   // the canvas under everything
    for (let i = chain.length - 1; i >= 0; i--) {
      const { bg, op } = chain[i];
      const outside = base;
      if (bg && bg.a > 0) base = bg.a >= 1 ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : over(bg, base);
      if (i === 0 && inner) base = inner.a >= 1 ? { r: inner.r, g: inner.g, b: inner.b, a: 1 } : over(inner, base);
      if (op < 1) base = mix(base, outside, op);
    }
    return base;
  };
  /* Product of every opacity on the chain. Zero means the element is not on
     screen at all, which is not a contrast question — the same reason the
     element's own `opacity: 0` is skipped below. */
  const visibility = (chain) => chain.reduce((acc, l) => acc * l.op, 1);

  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest('[aria-hidden="true"], svg, .sr-only, script, style, noscript')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const chain = chainOf(el);
    if (visibility(chain) === 0) continue;
    const bg = composite(chain, null);

    /* Type painted from a gradient. `background-clip: text` with a transparent
       fill means `color` is not the colour of anything: read literally it
       measures 1.00:1 against its own backdrop and fails a headline that is
       perfectly legible. The colour of the glyphs is the gradient, and since
       every sRGB interpolation between two stops has a luminance between
       theirs, checking the stops checks every frame of an animated one.
       Each stop is emitted as its own row, so the report names the stop that
       is too light rather than the element. */
    const clipsText = /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || '');
    const fillRaw = parse(cs.webkitTextFillColor || cs.color);
    const painted = [];
    if (clipsText && fillRaw && fillRaw.a === 0) {
      for (const m of (cs.backgroundImage || '').matchAll(/rgba?\([^)]+\)/g)) {
        const c = parse(m[0]);
        if (c && c.a > 0) painted.push(composite(chain, c));
      }
      /* A gradient with no readable stop at all is a real failure, not a skip. */
      if (!painted.length) painted.push({ r: bg.r, g: bg.g, b: bg.b, a: 1 });
    } else {
      const fgRaw = parse(cs.color);
      if (!fgRaw) continue;
      painted.push(composite(chain, fgRaw));
    }
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const sel = el.id ? '#' + el.id
      : el.tagName.toLowerCase() + (el.className && el.className.toString ? '.' + el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : '');
    for (const fg of painted) {
      out.push({
        sel: painted.length > 1 ? `${sel} (gradient stop)` : sel,
        text: text.slice(0, 44),
        fg: [fg.r, fg.g, fg.b], bg: [bg.r, bg.g, bg.b],
        size, weight,
      });
    }
  }
  return out;
};

/* ---- colour maths, host side --------------------------------------------- */

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const oklchL = ([R, G, B]) => {
  const r = lin(R), g = lin(G), b = lin(B);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100;
};

/* ---- run ------------------------------------------------------------------ */

const server = await serve();
const browser = await pw.chromium.launch();
const fails = [];
let checked = 0;

for (const path of PAGES) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url + path, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Reveal animations start at opacity 0; a hidden node is not a contrast
    // question, but it is not evidence of passing either.
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
    /* Settle every animation to its LAST frame before measuring. Now that the
       probe folds `opacity` into what it reports, an element caught mid-entry
       reads as a failure that does not exist — the hero float, 900ms into a
       720ms fade, was reported at 1.31:1 against a backdrop that only exists
       for a fraction of a second.
       Zero duration with zero delay rather than `animation: none`: with
       `fill-mode: both` still in force this snaps to the `to` keyframe, which
       is the state a visitor actually reads. `animation: none` would instead
       drop back to the BASE rule, and for anything that is only made visible
       by its animation that is the wrong end of the timeline. */
    await page.addStyleTag({ content: `*, *::before, *::after {
      animation-delay: 0s !important; animation-duration: 0s !important;
      animation-iteration-count: 1 !important;
      transition-delay: 0s !important; transition-duration: 0s !important; }` });
    await page.waitForTimeout(350);
    const nodes = await page.evaluate(PROBE);
    await ctx.close();

    for (const n of nodes) {
      checked++;
      const ratio = contrast(n.fg, n.bg);
      const large = n.size >= 24 || (n.size >= 18.66 && n.weight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        fails.push({ path, width, kind: 'contrast', ...n, ratio, need });
        continue;
      }
      // The lightness rule applies to reading text on a LIGHT ground only —
      // inside a dark island the constraint is the mirror of itself, and the
      // contrast check above already enforces it there.
      const paper = lum(n.bg) > 0.5;
      const L = oklchL(n.fg);
      if (paper && !large && L > MAX_READING_L) {
        fails.push({ path, width, kind: 'lightness', ...n, L });
      }
    }
  }
}

await browser.close();
server.close();

const rgb = (c) => `rgb(${c.map(Math.round).join(' ')})`;
console.log(`${checked} text nodes measured across ${PAGES.length} pages × ${WIDTHS.length} widths`);
if (!fails.length) {
  console.log(`✓ every reading colour clears WCAG AA and sits at or below L ${MAX_READING_L}% on paper`);
  process.exit(0);
}
console.log(`\n✗ ${fails.length} failing:\n`);
for (const f of fails.slice(0, 40)) {
  const where = `${f.path} @${f.width}  ${f.sel}`;
  if (f.kind === 'contrast') {
    console.log(`  ${where}\n     ${f.ratio.toFixed(2)}:1 (needs ${f.need}) ${rgb(f.fg)} on ${rgb(f.bg)} · ${f.size}px/${f.weight}\n     "${f.text}"`);
  } else {
    console.log(`  ${where}\n     L ${f.L.toFixed(1)}% > ${MAX_READING_L}% ${rgb(f.fg)} · ${f.size}px\n     "${f.text}"`);
  }
}
if (fails.length > 40) console.log(`  … and ${fails.length - 40} more`);
process.exit(1);
