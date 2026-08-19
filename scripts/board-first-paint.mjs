// PERCHE' LA CARD ARRIVA TARDI, misurato DENTRO la pagina.
// Il polling da fuori (`page.evaluate` in loop) non puo' misurare questo: ogni
// chiamata aspetta il main thread, quindi proprio mentre l'app e' occupata la
// sonda smette di campionare — e' cieca esattamente dove serve. Qui un
// MutationObserver segna gli eventi nel tempo della pagina.
import { webkit } from 'playwright';
const url = process.argv[2] || 'https://localhost:3333/';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

await ctx.addInitScript(() => {
  window.__marks = [];
  const mark = (k) => { if (!window.__marks.some(m => m[1] === k)) window.__marks.push([Math.round(performance.now()), k]); };
  window.__mark = mark;
  mark('script');
  const check = () => {
    if (document.querySelector('[data-testid^="kanban-column-"]')) mark('colonna');
    if (document.querySelector('[data-testid^="kanban-column-count-"]')?.textContent?.trim()) mark('conteggio:' + document.querySelector('[data-testid^="kanban-column-count-"]').textContent.trim());
    if (document.querySelector('[data-task-id]')) mark('card');
    if (document.body && document.body.children.length) mark('body');
  };
  const obs = new MutationObserver(check);
  document.addEventListener('DOMContentLoaded', () => {
    mark('DOMContentLoaded');
    obs.observe(document.documentElement, { childList: true, subtree: true });
    check();
  });
  // Long task: chi tiene il main thread durante l'attesa.
  try {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ entryTypes: ['longtask'] });
  } catch {}
  // Ogni fetch verso l'API, col suo tempo di risposta.
  window.__net = [];
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = String(typeof a[0] === 'string' ? a[0] : a[0]?.url ?? '');
    const s = Math.round(performance.now());
    return of.apply(this, a).then((r) => { if (u.includes('/api/')) window.__net.push([s, Math.round(performance.now()), new URL(u, location.href).pathname]); return r; });
  };
});

const p = await ctx.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(12000);
await p.reload({ waitUntil: 'commit' });
await p.waitForFunction(() => window.__marks?.some(m => m[1] === 'card'), null, { timeout: 40000 }).catch(() => console.log('!! nessuna card entro 40s'));
await p.waitForTimeout(1500);

const r = await p.evaluate(() => ({ marks: window.__marks, long: window.__long, net: window.__net }));
console.log('-- momenti (ms dal navigation start) --');
for (const [ms, k] of r.marks) console.log(String(ms).padStart(6), k);
console.log('\n-- long task > 50ms --');
for (const [s, d] of (r.long || [])) console.log(String(s).padStart(6), '+', d, 'ms');
console.log('\n-- fetch API (start -> end) --');
for (const [s, e, u] of (r.net || []).sort((a, b) => a[0] - b[0]).slice(0, 40)) console.log(String(s).padStart(6), '->', String(e).padStart(6), `(${e - s}ms)`, u);
await b.close();
