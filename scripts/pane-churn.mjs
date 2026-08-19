// CHI MUOVE LO STATO DELLE PANE A SCHERMO FERMO.
// Il PUT parte quando `lastSeq` cambia. A finestra ferma non deve cambiare
// niente: se cambia, qualcuno dispaccia un'azione in un ciclo. Qui si guarda
// COSA cambia nello snapshot fra un PUT e il successivo — il diff nomina il
// colpevole meglio di qualunque stack minificato.
import { webkit } from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
await ctx.addInitScript(() => {
  window.__puts = [];
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = String(typeof a[0] === 'string' ? a[0] : a[0]?.url ?? '');
    const init = a[1] || {};
    if (u.includes('pane-store-v2') && (init.method || '').toUpperCase() === 'PUT') {
      try { window.__puts.push({ t: Math.round(performance.now()), body: JSON.parse(String(init.body)) }); } catch {}
    }
    return of.apply(this, a);
  };
});
const p = await ctx.newPage();
await p.goto('https://localhost:3333/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(25000);
const puts = await p.evaluate(() => window.__puts);
console.log('PUT osservati:', puts.length);
const diff = (a, b, path = '', out = []) => {
  if (out.length > 12) return out;
  const ka = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of ka) {
    const va = a?.[k], vb = b?.[k];
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) diff(va, vb, path + '.' + k, out);
    else out.push(`${path}.${k}: ${JSON.stringify(va)?.slice(0, 70)}  →  ${JSON.stringify(vb)?.slice(0, 70)}`);
  }
  return out;
};
for (let i = 1; i < puts.length; i++) {
  console.log(`\n== PUT ${i} → ${i + 1}  (+${puts[i].t - puts[i - 1].t}ms) ==`);
  const d = diff(puts[i - 1].body, puts[i].body);
  console.log(d.length ? d.join('\n') : '  (NESSUNA DIFFERENZA: si riscrive lo stesso stato)');
}
await b.close();
