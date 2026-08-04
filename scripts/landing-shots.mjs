/**
 * Shoot the landing page's product images from the real app.
 *
 *   bun run build:landing && node scripts/landing-shots.mjs [--only ship,run] [--strict]
 *
 * Every image here is the actual client running on the demo's sample data —
 * the same bundle the interactive demo embeds — so there is nothing to keep in
 * sync with the product by hand.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * SHOOT A WHOLE THING, AT THE SIZE IT WILL BE SEEN. The first half of that was
 * already here and it fixed a real defect: the set before this one clipped
 * 650×340 rectangles out of the middle of the UI and every one ended mid-row,
 * mid-word, mid-button. The second half was missing, and it is what made the
 * images unreadable anyway.
 *
 * Two ratios, and they are not the same number:
 *
 *   OVERSAMPLE      = asset px ÷ rendered CSS px.  Must be exactly 2.00, so the
 *                     asset is retina-sharp and not one byte heavier.
 *   CONTENT SCALE   = rendered CSS px ÷ logical (captured) CSS px.  Must sit in
 *                     0.90–1.10. Under it the app's own 13px type falls below
 *                     ~11px and stops reading; over it the capture was too small
 *                     and is being stretched, which collapses the oversample.
 *
 * Measured on the shipped set before this change: see 0.36 (13px type landing
 * at 4.7px), organize 0.57, ship 0.64, reach 0.70, run 0.85, own 0.98. Only the
 * last one was legible. For comparison val.town serves its product shots at
 * content scale 1.00, and Cursor, Anthropic and Devin do not photograph the
 * product at all — they rebuild the UI in live DOM at 11-13px real text.
 *
 * The consequence is the useful part: you cannot photograph a 1240px-wide
 * window and show it 570px wide. Either the page renders the image bigger, or
 * the shot is of something smaller — one pane, one card, one popover. The
 * geometry and "show one feature at a time" turn out to be the same constraint,
 * which is why `render` below is a required field and not a hint.
 *
 * Floating-splits is on for the desktop shots: it is a real mode of the app
 * (gaps instead of hairlines) and it is what gives a pane rounded corners of
 * its own, so one card can be lifted out and still look like a finished object.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pw;
// Since the site moved to Astro the hand-written assets — and the demo build —
// live under landing/public/, which is what this server has to serve and where
// the images have to land. dist/ would work too, but only after a build; public/
// is the source and never stale.
const ROOT = resolve(fileURLToPath(new URL('../landing/public', import.meta.url)));
const OUT = join(ROOT, 'img');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(',')) : null;
})();
const strict = process.argv.includes('--strict');

/* ---- the two ratios ------------------------------------------------------ */

/** Capture density. Also the oversample ratio, when logical ≈ rendered. */
const OVERSAMPLE = 2;
/**
 * rendered CSS px ÷ logical CSS px — a BAND, not a floor, because the two
 * ratios are one constraint seen twice.
 *
 * Under 0.90 the app's own 13px type falls below ~11px and stops reading. Over
 * 1.10 the opposite failure: the subject was captured too small, so the asset is
 * being stretched and the oversample collapses — a 326px-wide capture served at
 * 640px is 1.02× and looks soft no matter how sharp the source was.
 *
 * Both edges say the same thing: capture the subject at the width the page will
 * serve it at.
 */
const MIN_CONTENT_SCALE = 0.9;
const MAX_CONTENT_SCALE = 1.1;

/**
 * The widest CSS width the page ever renders each image at. Read off
 * landing/styles.css, and it is the *widest* case rather than the desktop one:
 * `.fitem__shot { max-width: 640px }` under the 1024px breakpoint is larger
 * than the 569px the two-column grid gives at 1440px, so 640 is the number the
 * asset has to satisfy.
 *
 * When the layout changes, these change with it — they are the contract between
 * this script and the stylesheet, and the check below is what stops the two
 * from drifting apart in silence.
 */
const RENDER = {
  organize: 1132, // .fitem--slab: full container width (--maxw 1180 − 2×24 padding)
  run: 640,
  see: 640,
  ship: 640,
  reach: 390,     // .shot--phone max-width (was 272: that alone put it at 0.70)
  own: 340,       // .shot--narrow max-width
  poster: 1272,   // .demo max-width 1320 − 2×24 padding
};

const scales = [];

/** Record and judge one shot's geometry. Returns the human-readable summary. */
function record(name, logicalWidth, assetWidth, kb) {
  const render = RENDER[name];
  const scale = render / logicalWidth;
  const oversample = assetWidth / render;
  const ok = scale >= MIN_CONTENT_SCALE && scale <= MAX_CONTENT_SCALE;
  const why = scale < MIN_CONTENT_SCALE ? 'shrunk' : scale > MAX_CONTENT_SCALE ? 'stretched' : '';
  scales.push({ name, logicalWidth, render, assetWidth, scale, oversample, ok, why });
  return `${Math.round(logicalWidth)}→${render} css · scale ${scale.toFixed(2)}${ok ? '' : ` ✗ ${why}`}`
    + ` · ${oversample.toFixed(2)}× · ${kb} KB`;
}

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

/* ---- in-page helpers: drive the app the way a user would, minus the ghost --- */

async function boot(browser, { width, height }, base) {
  // deviceScaleFactor is not a per-shot choice: it *is* the oversample ratio,
  // and the ratio is 2. `organize` used to boot at 1.6, which is how a shot ends
  // up at 3.88× the width it is served at.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: OVERSAMPLE });
  const page = await ctx.newPage();
  await page.goto(`${base}/app/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pane-id="terminal:cc1"]', { timeout: 45000 });
  // No tour, no pointer: a still image of a pointer mid-glide reads as a bug.
  await page.evaluate(() => { try { window.__topicsDemo.stop(); } catch { /* not up yet */ } });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const c = document.getElementById('landing-ghost-cursor');
    if (c) c.style.display = 'none';
  });
  return { ctx, page };
}

/**
 * PNG → WebP. Six @2x screenshots of a dark UI weigh 3.3 MB as PNG and 300 KB
 * as WebP at q82, with nothing visible lost — and this page asks the visitor to
 * download a live copy of the app in an iframe already.
 */
const run = promisify(execFile);
async function toWebp(pngPath) {
  const out = pngPath.replace(/\.png$/, '.webp');
  await run('cwebp', ['-quiet', '-q', '82', '-m', '6', pngPath, '-o', out]);
  await rm(pngPath);
  return Math.round((await stat(out)).size / 1024);
}

/** Gaps instead of hairlines — every pane becomes a card with its own corners. */
const floating = () => (state) => {
  const root = document.querySelector('#root');
  const cands = root ? root.querySelectorAll('div.bg-app-bg.overflow-hidden') : [];
  for (const el of cands) {
    if (el.className.indexOf('max-w-[100vw]') >= 0) {
      el.classList.toggle('floating-splits', state);
      return true;
    }
  }
  return false;
};

/**
 * Switch to a group. The demo seeds three (Principale = acme-web alone,
 * Progetti = three project windows, Agenti = the standalone Agents +
 * Dashboard panes), and the chips are the app's own SpaceSwitcher — so this is
 * one real click, not a layout the script builds by hand. It replaced a pair
 * of divider drags: a group already holds exactly what the shot is about.
 */
async function useGroup(page, spaceId) {
  await page.locator(`[role="tab"][data-space-id="${spaceId}"]`).first().click({ timeout: 8000 });
  await page.waitForTimeout(1400);
}

const activate = async (page, paneId) => {
  await page.locator(`[data-pane-id="${paneId}"]`).first().click({ timeout: 8000 });
  await page.waitForTimeout(1400);
};

/**
 * Quiet everything that is not the subject, then clip.
 *
 * This is the half of "one feature per picture" that cropping alone cannot do.
 * A pane captured with its own four edges still arrives full of the sidebar and
 * the other tabs; they are in frame because the frame is a rectangle. Draining
 * their colour and contrast leaves the context legible as context — you can
 * still tell it is a window — while the eye goes where the sentence next to it
 * is pointing.
 *
 * Applied to siblings only, walking up from the subject, so nothing inside the
 * subject is touched. `filter` on an ancestor would create a containing block
 * and move fixed descendants, hence the sibling walk rather than a single rule
 * on <body>.
 */
async function dim(page, selector, amount = 1) {
  await page.locator(selector).first().evaluate((el, a) => {
    const f = `saturate(${1 - 0.8 * a}) brightness(${1 - 0.45 * a}) blur(${0.6 * a}px)`;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      for (const sib of node.parentElement?.children ?? []) {
        if (sib !== node && sib instanceof HTMLElement) {
          sib.style.filter = f;
          sib.style.transition = 'none';
        }
      }
    }
  }, amount);
  await page.waitForTimeout(250);
}

/** Clip a rect with a little air around it, so corners and shadow survive. */
async function shotOf(page, selector, file, pad = 16) {
  const r = await page.locator(selector).first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  if (r.w < 40 || r.h < 40) throw new Error(`${file}: subject has no size (${r.w}x${r.h})`);
  const png = join(OUT, file);
  const logical = r.w + pad * 2;
  await page.screenshot({
    path: png,
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: logical, height: r.h + pad * 2 },
    scale: 'device',
  });
  const kb = await toWebp(png);
  return record(file.replace(/\.png$/, ''), logical, logical * OVERSAMPLE, kb);
}

/* ---- the seven ----------------------------------------------------------- */

const SHOTS = {
  /**
   * The demo's poster frame — what stands in for the live app until somebody
   * asks for it.
   *
   * The iframe is a full React client (449 KB on the wire, ~1.55 MB to parse)
   * and it is same-origin, so it shares the landing page's process and main
   * thread. `loading="lazy"` never helped: the frame starts around 585px and
   * Chrome's lazy threshold is 1250px, so every visitor paid for a React boot
   * while reading the headline. A ~60 KB picture holds the space instead, and
   * one click swaps in the real thing.
   *
   * Shot at the frame's own geometry so the poster and the app it replaces are
   * the same picture: no crossfade from a stretched image to a sharp one.
   */
  async poster(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1280, height: 720 }, base);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'demo-poster.png'), scale: 'device' });
    const kb = await toWebp(join(OUT, 'demo-poster.png'));
    await ctx.close();
    return record('poster', 1280, 1280 * OVERSAMPLE, kb);
  },

  /**
   * The whole window: the Progetti group, three projects open at once.
   *
   * This is the one L3 shot on the page, and it is the one that cannot satisfy
   * the scale rule while the layout renders it at 640px: three projects inside
   * 711 logical px would be unreadable for a different reason. It wants to be
   * served full-bleed (~1132px), and at that width today's 1240px capture lands
   * at scale 0.91. Until the layout offers a full-bleed slot, the check below
   * reports it rather than pretending.
   */
  async organize(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1240, height: 780 }, base);
    await useGroup(page, 'space:projects');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, 'organize.png'), scale: 'device' });
    const kb = await toWebp(join(OUT, 'organize.png'));
    await ctx.close();
    return record('organize', 1240, 1240 * OVERSAMPLE, kb);
  },

  /** One card: the Claude Code session, with its own tab bar and corners. */
  async run(browser, base) {
    // 1180 instead of 1820: the subject is one cell of a two-cell row, so the
    // viewport is what decides how wide the card comes out. 1180 puts it near
    // 700 logical px, which is what 640 rendered needs.
    const { ctx, page } = await boot(browser, { width: 1930, height: 860 }, base);
    await activate(page, 'terminal:cc1');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(700);
    const subject = '[data-pane-id="terminal:cc1"] >> xpath=ancestor::*[@data-group-cell][1]';
    await dim(page, subject);
    const size = await shotOf(page, subject, 'run.png');
    await ctx.close();
    return size;
  },

  /**
   * The dashboard. A whole dashboard cannot be read at 640px — it is a wide
   * object by nature — so this is the shot that has to become a crop of the part
   * the sentence is about (the spend row and one chart) rather than the pane.
   * Captured whole for now; the check reports the gap.
   */
  async see(browser, base) {
    // 900, not 1180: the KPI grid fills the pane, so the viewport is what sets
    // its width. At 1180 it came out 924 logical px for a 640px slot.
    const { ctx, page } = await boot(browser, { width: 900, height: 860 }, base);
    await useGroup(page, 'space:agents');
    await activate(page, '__dashboard__');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(900);
    // The subject is the numbers, not the pane. A whole dashboard is a wide
    // object and cannot be read at 640px; the sentence next to this image is
    // about what the agents cost, so the picture is the KPI grid and nothing
    // else. This is what "one feature per picture" looks like in practice.
    const subject = '[data-testid="kpi-card-grid"]';
    await dim(page, subject);
    const size = await shotOf(page, subject, 'see.png');
    await ctx.close();
    return size;
  },

  /** One card: the board, with a task in flight. */
  async ship(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1546, height: 900 }, base);
    await activate(page, 'kanban:c1');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(900);
    const subject = '[data-pane-id="kanban:c1"] >> xpath=ancestor::*[@data-group-cell][1]';
    await dim(page, subject);
    const size = await shotOf(page, subject, 'ship.png');
    await ctx.close();
    return size;
  },

  /** The whole app at phone width — a real 390pt viewport, not a mock frame. */
  async reach(browser, base) {
    const { ctx, page } = await boot(browser, { width: 390, height: 844 }, base);
    await useGroup(page, 'space:agents').catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'reach.png'), scale: 'device' });
    const kb = await toWebp(join(OUT, 'reach.png'));
    await ctx.close();
    return record('reach', 390, 390 * OVERSAMPLE, kb);
  },

  /** The model picker: every provider you can point it at, in one popover. */
  async own(browser, base) {
    const ISO = new Date(Date.now() - 42000).toISOString();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.addInitScript((iso) => {
      const SNAP = { generatedAt: iso, defaultProvider: 'claude-code', providers: [
        { name: 'claude-code', status: 'ready', isDefault: true, version: '2.1.220',
          models: ['claude-opus-5[1m]', 'claude-opus-5', 'claude-sonnet-5'], requirements: [], fetchedAt: iso },
        { name: 'codex', status: 'ready', isDefault: false, version: '0.44.0',
          models: ['gpt-5-codex', 'gpt-5', 'o3'], requirements: [], fetchedAt: iso },
        { name: 'claude', status: 'ready', isDefault: false,
          models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'], requirements: [], fetchedAt: iso },
      ] };
      let real = window.fetch;
      const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      const wrapped = (u, o) => (/providers\/snapshot/.test(String(u && u.url ? u.url : u)) ? Promise.resolve(J(SNAP)) : real(u, o));
      Object.defineProperty(window, 'fetch', { configurable: true, get() { return wrapped; }, set(v) { real = v; } });
    }, ISO);
    await page.goto(`${base}/app/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pane-id="terminal:cc1"]', { timeout: 45000 });
    await page.evaluate(() => { try { window.__topicsDemo.stop(); } catch { /* not up */ } });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2000);
    // Open a chat, then its provider/model picker.
    await page.evaluate(() => {
      const e = Array.from(document.querySelectorAll('span.truncate.leading-none')).find((x) => x.textContent.trim() === 'auth flow');
      const r = e && e.closest('div.group');
      if (r) r.click();
    });
    await page.waitForTimeout(2500);
    await page.locator('[data-testid="provider-model-picker"]').first().click({ force: true });
    await page.waitForSelector('[data-testid="provider-model-popover"]');
    await page.waitForTimeout(1100);
    await page.evaluate(() => { const c = document.getElementById('landing-ghost-cursor'); if (c) c.style.display = 'none'; });
    const size = await shotOf(page, '[data-testid="provider-model-popover"]', 'own.png', 14);
    await ctx.close();
    return size;
  },
};

/* ---- run ------------------------------------------------------------------ */
const server = await serve();
const browser = await chromium.launch();
let failed = 0;
for (const [name, fn] of Object.entries(SHOTS)) {
  if (only && !only.has(name)) continue;
  try {
    const info = await fn(browser, server.url);
    console.log(`${name.padEnd(9)} ok   ${info}`);
  } catch (e) {
    failed++;
    console.log(`${name.padEnd(9)} FAIL ${e.message}`);
  }
}
await browser.close();
server.close();

/* ---- the check ------------------------------------------------------------
 * Printed every run, enforced with --strict. The whole set is inside the band
 * now: the window shot got the full-bleed slot it needed and the dashboard shot
 * became the KPI grid rather than the whole pane, which is what "one feature per
 * picture" turns into once the geometry is the constraint deciding it.
 *
 * Since it is green, --strict is a real gate rather than a red light nobody
 * reads. Run it that way before shipping a layout change that moves any of the
 * widths in RENDER.
 */
if (scales.length) {
  const bad = scales.filter((s) => !s.ok);
  console.log(
    '\ncontent scale (rendered ÷ logical), band %s–%s',
    MIN_CONTENT_SCALE.toFixed(2), MAX_CONTENT_SCALE.toFixed(2),
  );
  for (const s of scales.sort((a, b) => a.scale - b.scale)) {
    const lo = Math.round(s.render / MAX_CONTENT_SCALE);
    const hi = Math.round(s.render / MIN_CONTENT_SCALE);
    console.log(
      `  ${s.name.padEnd(9)} ${s.scale.toFixed(2).padStart(5)}  ${s.oversample.toFixed(2)}×  ` +
      `${String(Math.round(s.logicalWidth)).padStart(4)} logical → ${String(s.render).padStart(4)} rendered` +
      (s.ok ? '   ok' : `   ✗ ${s.why}: capture it between ${lo} and ${hi} logical px`),
    );
  }
  if (bad.length) {
    console.log(`\n${bad.length}/${scales.length} below the floor: ${bad.map((b) => b.name).join(', ')}`);
    if (strict) failed++;
  }
}

process.exit(failed === 0 ? 0 : 1);
