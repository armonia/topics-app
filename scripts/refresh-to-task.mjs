// QUANTO CI METTE UN REFRESH A MOSTRARE UN TASK.
// Misura, dal reload, i quattro momenti che stanno fra il gesto e la card:
// primo paint, bundle eseguito, risposta del feed, prima card nel DOM.
import { webkit } from 'playwright';

const url = process.argv[2] || 'https://localhost:3333/';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();

const net = [];
p.on('response', (r) => {
  const u = new URL(r.url()).pathname;
  if (/^\/api\//.test(u)) net.push({ u, t: Date.now(), status: r.status() });
});

await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(10000); // prima visita: warm-up, non misurata

const t0 = Date.now();
net.length = 0;
await p.reload({ waitUntil: 'commit' });

const seen = {};
const mark = (k) => { if (!seen[k]) seen[k] = Date.now() - t0; };

// polling stretto: chi appare prima fra scheletro, colonne, card
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const s = await p.evaluate(() => ({
    paint: performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]),
    cards: document.querySelectorAll('[data-testid^="task-card"], [data-testid^="board-card"]').length,
    columns: document.querySelectorAll('[data-testid^="board-column"], [data-testid^="kanban-column"]').length,
    nodes: document.getElementsByTagName('*').length,
  })).catch(() => null);
  if (!s) { await p.waitForTimeout(50); continue; }
  if (s.nodes > 50) mark('dom');
  if (s.columns > 0) mark('colonne');
  if (s.cards > 0) { mark('prima_card'); break; }
  await p.waitForTimeout(50);
}

const paint = await p.evaluate(() => performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
console.log('paint:', JSON.stringify(paint));
console.log('milestones ms:', JSON.stringify(seen));
console.log('api (ms dal reload):');
for (const r of net) console.log(`  ${String(r.t - t0).padStart(6)}  ${r.status}  ${r.u}`);
await b.close();
