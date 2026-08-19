// COSA CHIEDE UN REFRESH. Conta le richieste per rotta, quante sono duplicate
// esatte, e quando arriva la prima card della board.
import { webkit } from 'playwright';
const url = process.argv[2] || 'https://localhost:3333/';
const b = await webkit.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(12000);

const reqs = [];
p.on('response', async (r) => {
  const u = new URL(r.url());
  if (!/^\/api\//.test(u.pathname)) return;
  let len = 0;
  try { len = Number((await r.headerValue('content-length')) || 0); } catch {}
  reqs.push({ path: u.pathname, full: u.pathname + u.search, t: Date.now(), status: r.status(), len });
});
const t0 = Date.now();
await p.reload({ waitUntil: 'commit' });

let firstCard = null;
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  const n = await p.evaluate(() =>
    document.querySelectorAll('[data-testid^="kanban-column-"]').length * 1000 +
    document.querySelectorAll('[data-testid^="card-"], [draggable="true"][data-task-id]').length
  ).catch(() => 0);
  if (n % 1000 > 0 && firstCard === null) { firstCard = Date.now() - t0; break; }
  await p.waitForTimeout(40);
}
await p.waitForTimeout(8000);

const byPath = new Map();
for (const r of reqs) byPath.set(r.path, (byPath.get(r.path) || 0) + 1);
const dupFull = new Map();
for (const r of reqs) dupFull.set(r.full, (dupFull.get(r.full) || 0) + 1);
const totalBytes = reqs.reduce((s, r) => s + r.len, 0);

console.log('prima card ms:', firstCard);
console.log('richieste api totali:', reqs.length, ' byte dichiarati:', (totalBytes / 1e6).toFixed(2), 'MB');
console.log('ultima richiesta a ms:', reqs.length ? reqs[reqs.length - 1].t - t0 : 0);
console.log('\n-- per rotta (top 15) --');
for (const [k, v] of [...byPath].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(v).padStart(5), k);
console.log('\n-- URL IDENTICI ripetuti (top 15) --');
for (const [k, v] of [...dupFull].sort((a, b) => b[1] - a[1]).slice(0, 15)) { if (v > 1) console.log(String(v).padStart(5), k.slice(0, 110)); }
console.log('\n-- le 10 risposte piu pesanti --');
for (const r of [...reqs].sort((a, b) => b.len - a.len).slice(0, 10)) console.log(String((r.len / 1024).toFixed(0)).padStart(7), 'KB  @', r.t - t0, 'ms ', r.path);
await b.close();
