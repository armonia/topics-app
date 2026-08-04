/**
 * Shoot the landing page's product images from the real app.
 *
 *   bun run build:landing && node scripts/landing-shots.mjs [--only ship,run]
 *
 * Every image here is the actual client running on the demo's sample data —
 * the same bundle the interactive demo embeds — so there is nothing to keep in
 * sync with the product by hand.
 *
 * The rule that makes these read as product shots rather than as screenshots
 * someone sliced up: SHOOT A WHOLE THING. A pane is captured with its tab bar,
 * its four edges and the backdrop just outside its corners; the window shots
 * are the whole window. The previous set clipped 650×340 rectangles out of the
 * middle of the UI, and every one of them ended mid-row, mid-word, mid-button —
 * which is exactly what "sembrano tagli di screenshot" describes.
 *
 * Floating-splits is on for the desktop shots: it is a real mode of the app
 * (gaps instead of hairlines) and it is what gives a pane rounded corners of
 * its own, so one card can be lifted out and still look like a finished object.
 *
 * Geometry: each shot picks a viewport that makes its subject roughly the size
 * it will be rendered at, then captures at deviceScaleFactor 2 for the @2x
 * asset. Nothing is ever resampled — the app is rendered at that density.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pw;
const ROOT = resolve(fileURLToPath(new URL('../landing', import.meta.url)));
const OUT = join(ROOT, 'img');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(',')) : null;
})();

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

async function boot(browser, { width, height, dsf = 2 }, base) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf });
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
 * Reshape the window: acme-web takes `row` of the height, its split at `col`.
 * Same gesture the app ships — mousedown on the divider, mousemoves on window,
 * mouseup (Layout/SplitTree.tsx) — so nothing here depends on internals a
 * refactor would move.
 */
async function shape(page, row, col) {
  await page.evaluate(async ({ row, col }) => {
    const box = (el) => el.getBoundingClientRect();
    const fire = (t, type, x, y, buttons) => t.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: buttons || 0, detail: 1,
    }));
    const drag = async (el, dx, dy) => {
      const b = box(el);
      const px = b.left + b.width / 2, py = b.top + b.height / 2;
      fire(el, 'mousedown', px, py, 1);
      for (let i = 1; i <= 10; i++) {
        fire(window, 'mousemove', px + (dx * i) / 10, py + (dy * i) / 10, 1);
        await new Promise((r) => setTimeout(r, 12));
      }
      fire(window, 'mouseup', px + dx, py + dy, 0);
    };

    const rowD = Array.from(document.querySelectorAll('[data-split-divider="col"]'))
      .find((e) => !e.closest('[data-testid="project-window"]'));
    if (rowD && row != null) {
      const p = box(rowD.parentElement);
      await drag(rowD, 0, Math.round(p.top + p.height * row - box(rowD).top));
    }
    await new Promise((r) => setTimeout(r, 400));
    const t = document.querySelector('[data-pane-id="terminal:cc1"]');
    const win = t && t.closest('[data-testid="project-window"]');
    const innerD = win && win.querySelector('[data-split-divider="row"]');
    if (innerD && col != null) {
      const p = box(innerD.parentElement);
      await drag(innerD, Math.round(p.left + p.width * col - box(innerD).left), 0);
    }
  }, { row, col });
  await page.waitForTimeout(900);
}

const activate = async (page, paneId) => {
  await page.locator(`[data-pane-id="${paneId}"]`).first().click({ timeout: 8000 });
  await page.waitForTimeout(1400);
};

/** Clip a rect with a little air around it, so corners and shadow survive. */
async function shotOf(page, selector, file, pad = 16) {
  const r = await page.locator(selector).first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  if (r.w < 40 || r.h < 40) throw new Error(`${file}: subject has no size (${r.w}x${r.h})`);
  const png = join(OUT, file);
  await page.screenshot({
    path: png,
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 },
    scale: 'device',
  });
  const kb = await toWebp(png);
  return `${Math.round(r.w + pad * 2)}x${Math.round(r.h + pad * 2)} css · ${kb} KB`;
}

/* ---- the six ------------------------------------------------------------- */

const SHOTS = {
  /** The whole window: three projects open at once, sidebar included. */
  async organize(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1240, height: 780, dsf: 1.6 }, base);
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, 'organize.png'), scale: 'device' });
    const kb = await toWebp(join(OUT, 'organize.png'));
    await ctx.close();
    return `1240x780 css (whole window) · ${kb} KB`;
  },

  /** One card: the Claude Code session, with its own tab bar and corners. */
  async run(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1820, height: 800 }, base);
    await shape(page, 0.86, 0.62);
    await activate(page, 'terminal:cc1');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(700);
    const size = await shotOf(page, '[data-pane-id="terminal:cc1"] >> xpath=ancestor::*[@data-group-cell][1]', 'run.png');
    await ctx.close();
    return size;
  },

  /** One card: the dashboard. */
  async see(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1820, height: 800 }, base);
    await shape(page, 0.86, 0.26);
    await activate(page, 'dashboard:c1');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(900);
    const size = await shotOf(page, '[data-pane-id="dashboard:c1"] >> xpath=ancestor::*[@data-group-cell][1]', 'see.png');
    await ctx.close();
    return size;
  },

  /** One card: the board, with a task in flight. */
  async ship(browser, base) {
    const { ctx, page } = await boot(browser, { width: 1820, height: 800 }, base);
    await shape(page, 0.86, 0.26);
    await activate(page, 'kanban:c1');
    await page.evaluate(floating(true), true);
    await page.waitForTimeout(900);
    const size = await shotOf(page, '[data-pane-id="kanban:c1"] >> xpath=ancestor::*[@data-group-cell][1]', 'ship.png');
    await ctx.close();
    return size;
  },

  /** The whole app at phone width — a real 390pt viewport, not a mock frame. */
  async reach(browser, base) {
    const { ctx, page } = await boot(browser, { width: 390, height: 844, dsf: 2 }, base);
    await activate(page, 'agents:c1').catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'reach.png'), scale: 'device' });
    const kb = await toWebp(join(OUT, 'reach.png'));
    await ctx.close();
    return `390x844 css (whole phone window) · ${kb} KB`;
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
process.exit(failed === 0 ? 0 : 1);
