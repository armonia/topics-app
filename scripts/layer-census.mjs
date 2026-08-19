// Censimento dei LAYER del compositore: chi ha backdrop-filter, filter, opacity
// animata, will-change, transform 3d — le proprietà che promuovono un elemento
// a layer con backing IOSurface (che la heap JS non vede).
import { webkit } from 'playwright';

const url = process.argv[2] || 'https://localhost:3333/';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(url, { waitUntil: 'domcontentloaded' });
console.log('domcontentloaded', Date.now() - t0, 'ms');
await p.waitForTimeout(8000);

const out = await p.evaluate(() => {
  const props = ['backdropFilter', 'webkitBackdropFilter', 'filter', 'willChange', 'transform', 'mixBlendMode'];
  const hits = { backdrop: [], filter: [], willChange: [], transform3d: [], blend: [] };
  const all = document.getElementsByTagName('*');
  const owner = (el) => {
    const t = el.closest('[data-testid]')?.getAttribute('data-testid');
    return t || `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 60)}`;
  };
  for (const el of all) {
    const cs = getComputedStyle(el);
    const bd = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bd && bd !== 'none') hits.backdrop.push(owner(el) + ' | ' + bd.slice(0, 40));
    if (cs.filter && cs.filter !== 'none') hits.filter.push(owner(el) + ' | ' + cs.filter.slice(0, 40));
    if (cs.willChange && cs.willChange !== 'auto') hits.willChange.push(owner(el) + ' | ' + cs.willChange);
    if (cs.transform && /matrix3d|translateZ|translate3d/.test(cs.transform)) hits.transform3d.push(owner(el));
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') hits.blend.push(owner(el));
  }
  const tally = (arr) => {
    const m = new Map();
    for (const k of arr) m.set(k, (m.get(k) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  };
  return {
    nodes: all.length,
    svg: document.querySelectorAll('svg').length,
    canvas: document.querySelectorAll('canvas').length,
    counts: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length])),
    top: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, tally(v)])),
  };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
