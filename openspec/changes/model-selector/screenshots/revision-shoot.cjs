// Screenshots and measurements of revision-mockup.html, WebKit. Run from the repo: node openspec/changes/model-selector/screenshots/revision-shoot.cjs
const path = require('path');
const fs = require('fs');
const NM = path.join(__dirname, '../../../../node_modules');
const { webkit } = require(path.join(NM, 'playwright'));
const AXE = fs.readFileSync(path.join(NM, 'axe-core/axe.min.js'), 'utf8');
const OUT = __dirname;
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'revision-mockup.html'));
  await page.waitForTimeout(300);
  const panels = await page.$$eval('[data-panel]', (els) => els.map((e) => e.getAttribute('data-panel')));
  for (const id of panels) await (await page.$(`[data-panel="${id}"]`)).screenshot({ path: path.join(OUT, `revision-${id}.png`) });
  const measure = (h) => page.$$eval('[data-panel]', (els, h) => els.map((p) => {
    if (h && p.classList.contains('pop') && !p.classList.contains('phone')) p.style.setProperty('--h', h + 'px');
    const r = p.getBoundingClientRect();
    const body = p.querySelector('.cols, .list, .det, .plist');
    const br = body ? body.getBoundingClientRect() : null;
    const cols = [...p.querySelectorAll('.col')].map((c) => {
      const cr = c.getBoundingClientRect();
      const items = [...c.querySelectorAll('.row, .more, .cr')];
      const vis = items.filter((x) => x.getBoundingClientRect().bottom <= cr.bottom + 0.5).length;
      const heads = [...c.querySelectorAll('.head')];
      const vias = [...c.querySelectorAll('.row .l2')].map((v) => Math.round(v.getBoundingClientRect().left * 2) / 2);
      return { makers: heads.map((x) => x.querySelector('.mk').textContent), items: items.length, visible: vis, clientH: Math.round(c.clientHeight), scrollH: c.scrollHeight,
        headH: [...new Set(heads.map((x) => Math.round(x.getBoundingClientRect().height)))], viaX: [...new Set(vias)] };
    });
    const clamped = [...p.querySelectorAll('.row .lb')].filter((x) => x.scrollHeight > x.clientHeight + 1).map((x) => ({ t: x.textContent.trim(), title: x.getAttribute('title'), aria: x.parentElement.querySelector('.pick')?.getAttribute('aria-label') }));
    const sizes = {};
    for (const n of p.querySelectorAll('*')) { if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue; const s = getComputedStyle(n).fontSize; sizes[s] = (sizes[s] || 0) + 1; }
    const small = p.classList.contains('phone') ? [...p.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return { t: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30), h: Math.round(q.height), w: Math.round(q.width) }; }).filter((b) => b.h > 0 && (b.h < 44 || b.w < 44)) : undefined;
    const text = p.innerText;
    const banned = ['Altri', 'Altro', 'Other', 'Others', 'Model', 'Automatic', 'ago', 'Updated', 'Copy', 'Endpoint e agenti', 'Agenti', 'Run in terminal'].filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(text));
    const groupsInProviders = p.querySelector('[data-providers-level]') ? p.querySelectorAll('[data-providers-level] [role=group], [data-providers-level] [role=heading], [data-providers-level] h1, [data-providers-level] h2, [data-providers-level] h3, [data-providers-level] .head').length : undefined;
    const det = p.querySelector('.det');
    const prim = p.querySelector('[data-primary]');
    return { id: p.dataset.panel, w: Math.round(r.width), h: Math.round(r.height), bodyH: br ? Math.round(br.height) : null, bodyShare: br ? +(br.height / r.height).toFixed(3) : null,
      cols: cols.length ? cols : undefined, clamped, sizes, small, banned, groupsInProviders,
      det: det ? { clientH: det.clientHeight, scrollH: det.scrollHeight, primaryOffset: prim ? Math.round(prim.getBoundingClientRect().top - det.getBoundingClientRect().top) : undefined } : undefined,
      plist: p.querySelector('.plist') ? { clientH: p.querySelector('.plist').clientHeight, scrollH: p.querySelector('.plist').scrollHeight, cards: p.querySelectorAll('.acc').length } : undefined };
  }), h);
  const at456 = await measure(0);
  const at400 = await measure(400);
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => {
    const out = {};
    for (const sec of document.querySelectorAll('section.theme')) {
      const res = await window.axe.run(sec, { runOnly: { type: 'rule', values: ['color-contrast', 'nested-interactive', 'aria-required-children', 'scrollable-region-focusable', 'button-name', 'aria-allowed-role'] } });
      out[sec.dataset.themeName] = res.violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, html: n.html.slice(0, 100), msg: n.any?.[0]?.message })));
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT, 'revision-metrics.json'), JSON.stringify({ at456, at400, axe }, null, 1));
  console.log(JSON.stringify({ panels: panels.length, axe: Object.fromEntries(Object.entries(axe).map(([k, v]) => [k, v.length])) }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
