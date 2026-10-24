// shoot.mjs <base url> <out dir> <label> <engine> [opaque]: the model menu of
// the chat composer, open, on a board task chat, light and dark, at 2x.
// Writes the whole viewport, a crop around the menu (and its chip), a probe of
// what is on screen, and a diagnostic file (console, chip text, failures) so a
// capture that came out wrong can be told from a UI defect without a re-run.
import { chromium, webkit } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const [base, out, label, engine, mode] = process.argv.slice(2);
const tag = mode === 'opaque' ? `${engine}-opaque` : engine;
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
const probes = {};
const probesClosed = {};
const diag = {};
let failed = false;

// What is on screen: the crop box, the menu, the chip, the rows.
const probeFn = () => {
  const round = (n) => Math.round(n * 10) / 10;
  const boxOf = (e) => { const r = e.getBoundingClientRect(); return [round(r.x), round(r.y), round(r.width), round(r.height)]; };
  const describe = (e) => {
    const cs = getComputedStyle(e);
    return { tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 140), bg: cs.backgroundColor, backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '', opacity: cs.opacity, box: boxOf(e) };
  };
  const pop = document.querySelector('[data-testid="provider-model-popover"]');
  const chip = document.querySelector('[data-testid="provider-model-picker"]');
  const band = document.querySelector('[data-testid="model-selector-routing"]');
  const pr = pop.getBoundingClientRect();
  const cr = chip.getBoundingClientRect();
  const pad = 16;
  const x0 = Math.max(0, Math.min(pr.left, cr.left) - pad);
  const y0 = Math.max(0, Math.min(pr.top, cr.top) - pad);
  const x1 = Math.min(innerWidth, Math.max(pr.right, cr.right) + pad);
  const y1 = Math.min(innerHeight, Math.max(pr.bottom, cr.bottom) + pad);
  const clip = { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
  const chain = [];
  for (let e = band; e && e !== document.body; e = e.parentElement) chain.push(describe(e));
  const labels = [...pop.querySelectorAll('[data-testid="model-row-label"]')].map((e) => e.textContent.trim());
  return {
    clip,
    chain,
    popover: describe(pop),
    chip: { text: chip.innerText.trim(), box: boxOf(chip) },
    band: { route: band.getAttribute('data-route'), text: band.innerText.trim(), box: boxOf(band) },
    rows: document.querySelectorAll('[data-testid="model-row"]').length,
    rowLabels: labels.slice(0, 24),
    headings: [...pop.querySelectorAll('[data-testid="model-section-heading"]')].map((e) => e.textContent.trim().slice(0, 60)),
    viewport: [innerWidth, innerHeight],
    olderButtons: [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /^Precedenti \(|^Nascondi i precedenti/.test(t)),
  };
};

const LIGHT_BACKDROP = `
  body::before { background:
    radial-gradient(900px circle at 14% 4%, hsl(214 90% 82% / .70), transparent 56%),
    radial-gradient(820px circle at 90% 0%, hsl(262 80% 86% / .60), transparent 55%),
    linear-gradient(180deg, #eef1f8 0%, #e6eaf3 100%) !important; }
  body::after { display: none !important; }`;

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const events = [];
    const d = (diag[theme] = { events });
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) events.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => events.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    try {
      await page.goto(`${base}/app/?theme=${theme}`);
      await page.evaluate(() => { try { window.__topicsDemo && window.__topicsDemo.stop(); } catch { /* the tour is not the point */ } });
      const picker = page.locator('[data-testid="provider-model-picker"]').first();
      try {
        await picker.waitFor({ state: 'visible', timeout: 25000 });
      } catch {
        // The seeded pane did not mount: open the chat from the sidebar instead.
        d.openedFromSidebar = true;
        await page.getByText('Landing site rebuild', { exact: true }).first().click({ timeout: 8000 });
        await picker.waitFor({ state: 'visible', timeout: 20000 });
      }
      if (theme === 'light') await page.addStyleTag({ content: LIGHT_BACKDROP });
      await page.waitForTimeout(1500);
      d.htmlClass = await page.evaluate(() => document.documentElement.className);
      d.chipText = (await picker.innerText()).trim();
      await page.screenshot({ path: `${out}/diag-${tag}-${label}-${theme}-before.png` });

      await picker.click();
      const pop = page.locator('[data-testid="provider-model-popover"]');
      await pop.waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-testid="model-selector-routing"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="model-row"]').nth(2).waitFor({ state: 'visible', timeout: 10000 });

      if (mode === 'opaque') {
        // The web build's glass lets the panes behind show through unblurred.
        // The Mac app paints native vibrancy instead, so the capture fills the
        // popover with its own tint at full alpha.
        d.opaque = await page.evaluate(() => {
          const popover = document.querySelector('[data-testid="provider-model-popover"]');
          const glass = popover.classList.contains('glass-surface')
            ? popover
            : popover.closest('.glass-surface') || popover.querySelector('.glass-surface') || [...document.querySelectorAll('.glass-surface')].pop();
          const bg = getComputedStyle(glass).backgroundColor;
          let nums = (bg.match(/\d*\.?\d+/g) || []).slice(0, 3).map(Number);
          if (bg.startsWith('color(')) nums = nums.map((n) => Math.round(n * 255));
          const rgb = nums.join(', ');
          const style = document.createElement('style');
          style.textContent = `.glass-surface { background-color: rgb(${rgb}) !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }`;
          document.head.appendChild(style);
          return { bg, rgb, onPopover: glass === popover };
        });
        await page.waitForTimeout(300);
      }
      await page.mouse.move(8, 8);
      await page.waitForTimeout(200);

      // Closed first: «Precedenti (N)» on screen, the older rows hidden.
      const closed = await page.evaluate(probeFn);
      probesClosed[theme] = closed;
      await page.screenshot({ path: `${out}/${tag}-${label}-chiuso-${theme}-full.png` });
      // Then open the first company's older models (Anthropic), so the shot
      // shows which rows went to «Precedenti».
      await pop.getByRole('button', { name: /^Precedenti \(/ }).first().click();
      await pop.getByRole('button', { name: 'Nascondi i precedenti' }).first().waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(800);
      await page.mouse.move(8, 8);
      await page.waitForTimeout(200);
      const probe = await page.evaluate(probeFn);
      probe.olderOpened = probe.rowLabels.filter((l) => !closed.rowLabels.includes(l));
      probes[theme] = probe;
      await page.screenshot({ path: `${out}/${tag}-${label}-${theme}.png`, clip: probe.clip });
      await page.screenshot({ path: `${out}/${tag}-${label}-${theme}-full.png` });
    } catch (e) {
      failed = true;
      d.error = String(e).slice(0, 600);
      d.bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
      await page.screenshot({ path: `${out}/diag-${tag}-${label}-${theme}-fail.png` }).catch(() => {});
    } finally {
      d.events = events.slice(0, 60);
      await page.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${out}/${tag}-${label}-probe.json`, JSON.stringify(probes, null, 2));
  writeFileSync(`${out}/${tag}-${label}-chiuso-probe.json`, JSON.stringify(probesClosed, null, 2));
  writeFileSync(`${out}/diag-${tag}-${label}.json`, JSON.stringify(diag, null, 2));
}
console.log(engine, label, failed ? 'FAILED' : 'ok');
process.exitCode = failed ? 1 : 0;
