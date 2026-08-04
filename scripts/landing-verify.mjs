/**
 * The landing site's gate. Runs against the BUILT output.
 *
 *   cd landing && bun run build && cd .. && bun run check:landing
 *
 * Four things, in the order they cost. Each one exists because it caught a real
 * defect on this site, and each is written to fail loudly rather than to report:
 *
 *   1. LINKS      every internal href resolves to a file that exists. A
 *                 directory-format build turns a typo into a 404 that no test
 *                 sees, because nothing imports a page.
 *   2. LAYOUT     no page scrolls horizontally at any of three widths. The
 *                 comparison table set the document to 712px on a 390px phone
 *                 and every paragraph on the page inherited the scrollbar.
 *   3. AXE        WCAG violations, on every page type. Caught a skipped heading
 *                 level in a 127-item list and a scroll box no keyboard could
 *                 reach.
 *   4. BEHAVIOUR  the things that are not markup: the demo boots only when
 *                 asked, the copy button copies, the plan buttons lead
 *                 somewhere. The demo one is the important one — the whole
 *                 point of the poster is that /app/ is NOT fetched on load, and
 *                 that is invisible to every other check here.
 *
 * Contrast lives in its own script (`bun run check:contrast`) because it is the
 * slow one and it has a different owner: the palette, not the markup.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const AXE = resolve(fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)));
const WIDTHS = [1440, 768, 390];
const SAMPLE = ['/', '/changelog/', '/privacy/', '/blog/', '/wiki/', '/wiki/pty/',
                '/compare/claude-code-guis/', '/blog/electron-vs-tauri-memory-measured/'];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
                '.webp': 'image/webp', '.svg': 'image/svg+xml', '.xml': 'application/xml',
                '.md': 'text/plain', '.woff2': 'font/woff2' };

const problems = [];
const fail = (area, msg) => problems.push(`${area}: ${msg}`);

/* ---- 1. links -------------------------------------------------------------- */

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const pages = [];
for await (const f of walk(ROOT)) {
  // /app/ is the demo: a whole second application, not our markup to police.
  if (f.endsWith('.html') && !f.includes('/app/')) pages.push(f);
}

let linkCount = 0;
for (const f of pages) {
  const html = await readFile(f, 'utf8');
  const from = '/' + relative(ROOT, f).replace(/index\.html$/, '');
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
    const u = m[1];
    if (u.startsWith('//')) continue;     // protocol-relative, not ours
    linkCount++;
    const candidates = [join(ROOT, u), join(ROOT, u, 'index.html'), join(ROOT, `${u}.html`)];
    let ok = false;
    for (const c of candidates) {
      try { if ((await stat(c)).isFile()) { ok = true; break; } } catch { /* next */ }
    }
    if (!ok) fail('links', `${from} → ${u} (404)`);
  }
}
console.log(`links      ${linkCount} internal across ${pages.length} pages`);

/* ---- server ---------------------------------------------------------------- */

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
const browser = await pw.chromium.launch();
const axeSrc = await readFile(AXE, 'utf8');

/* ---- 2 + 3. layout and axe -------------------------------------------------- */

let axeChecks = 0;
for (const path of SAMPLE) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
    await page.waitForTimeout(300);

    const { docW, winW } = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth, winW: window.innerWidth,
    }));
    if (docW > winW + 1) fail('layout', `${path} @${width} scrolls horizontally (${docW} > ${winW})`);

    await page.addScriptTag({ content: axeSrc });
    const violations = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, at: v.nodes[0]?.target?.join(' ') }));
    });
    axeChecks++;
    for (const v of violations) fail('axe', `${path} @${width} ${v.impact} ${v.id} ×${v.n} at ${v.at}`);
    await ctx.close();
  }
}
console.log(`layout     ${SAMPLE.length * WIDTHS.length} page/width combinations, no horizontal scroll`);
console.log(`axe        ${axeChecks} runs`);

/* ---- 4. behaviour ----------------------------------------------------------- */

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const appRequests = [];
  page.on('request', (r) => { if (r.url().includes('/app/')) appRequests.push(r.url()); });

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  // The whole reason the poster exists.
  if (appRequests.length) fail('behaviour', `the demo fetched ${appRequests.length} /app/ resources before anyone asked for it`);
  const srcBefore = await page.locator('#demoFrame').getAttribute('src');
  if (srcBefore) fail('behaviour', `#demoFrame has a src (${srcBefore}) before the poster is clicked`);

  const posterVisible = await page.locator('#demoPoster').isVisible();
  if (!posterVisible) fail('behaviour', 'the demo poster is not visible');

  await page.locator('#demoPoster').click();
  await page.waitForTimeout(400);
  const srcAfter = await page.locator('#demoFrame').getAttribute('src');
  if (!srcAfter) fail('behaviour', 'clicking the poster did not give #demoFrame a src');
  if (await page.locator('#demoPoster').isVisible()) fail('behaviour', 'the poster is still visible after booting');
  if (!appRequests.length) fail('behaviour', 'no /app/ request after the poster was clicked');

  // Every plan button must lead somewhere real — a dead `#pricing` href is the
  // failure this page had for months, dressed as a waitlist.
  for (const el of await page.locator('[data-checkout]').all()) {
    const plan = await el.getAttribute('data-checkout');
    const href = await el.getAttribute('href');
    if (!href || href === '#pricing') fail('behaviour', `plan "${plan}" has no destination (href=${href})`);
  }

  // The copy button. Clipboard needs permission in a real browser; the check is
  // that the handler is wired and the target text is what we mean to hand over.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-copy]').first().click();
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (!copied.includes('agents.md')) fail('behaviour', `the copy button put "${copied.slice(0, 60)}" on the clipboard`);
  const btnText = await page.locator('[data-copy]').first().textContent();
  if (btnText?.trim() !== 'Copied') fail('behaviour', `the copy button did not confirm (says "${btnText?.trim()}")`);

  await ctx.close();
  console.log('behaviour  demo boots only on request · plans have destinations · copy works');
}

await browser.close();
srv.close();

if (!problems.length) {
  console.log('\n✓ landing gate green');
  process.exit(0);
}
console.log(`\n✗ ${problems.length} problem(s):\n`);
for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
if (problems.length > 40) console.log(`  … and ${problems.length - 40} more`);
process.exit(1);
