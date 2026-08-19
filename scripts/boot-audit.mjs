/**
 * COSA CHIEDE UN REFRESH, e quanto ci mette la prima card ad apparire.
 *
 * Conta le richieste per rotta, quante sono duplicate esatte, quali pesano, e
 * cronometra il momento in cui la board disegna la sua prima scheda.
 *
 * IL NUMERO NON VALE SENZA LE CONDIZIONI IN CUI È STATO PRESO, ed è una lezione
 * pagata su questa stessa pagina. Il 19/08 la prima card è passata da 7.176 ms
 * a 464 ms dopo aver chiuso un ciclo di scritture; qualche ora dopo la stessa
 * misura diceva 6.200-8.400 ms senza che nulla di rilevante fosse cambiato nel
 * codice. La differenza non era l'app: era la MACCHINA, a load 136-221 per
 * ffmpeg, Dia e Spotify, con 9 GB di swap occupato.
 *
 * Verificato invece di supposto: `scripts/event-loop-lag.ts` misurava il server
 * SANO nello stesso momento (mediana 3,3 ms, nessuno stallo sopra il mezzo
 * secondo) e i dati del feed arrivavano al client a 1.809 ms mentre la card
 * compariva a 8.375. Quindi il tempo se ne andava nel main thread del
 * renderer, che su una CPU contesa non ha modo di tenere il passo.
 *
 * Per questo lo script ora STAMPA il carico accanto al risultato: un lettore
 * che trovi 8 secondi con load 150 sa che sta guardando la macchina, non una
 * regressione — e un confronto fra due numeri presi a carichi diversi non è un
 * confronto. Se serve un verdetto, si misura a load basso (sotto ~12 su una
 * macchina a 12 core) oppure si confrontano due bundle nello STESSO minuto.
 */
import { webkit } from 'playwright';
import { execSync } from 'child_process';

/** Il carico medio a un minuto: la variabile che decide se questa misura vale. */
function loadMedio() {
  try {
    const m = execSync('uptime', { encoding: 'utf-8' }).match(/load averages?: *([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
const CARICO_SANO = 12;
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

const carico = loadMedio();
if (carico !== null && carico > CARICO_SANO) {
  console.log(
    `\n⚠ MACCHINA CARICA — load ${carico.toFixed(0)} (sano: sotto ~${CARICO_SANO}).\n` +
    `  I tempi qui sotto descrivono questa macchina adesso, non l'app: la prima\n` +
    `  card vive nel main thread del renderer, che su una CPU contesa non tiene\n` +
    `  il passo. Per un verdetto, rimisura a carico basso o confronta due bundle\n` +
    `  nello stesso minuto. (Il server si controlla a parte: event-loop-lag.ts.)\n`,
  );
}
console.log('prima card ms:', firstCard, carico !== null ? `(load ${carico.toFixed(0)})` : '');
console.log('richieste api totali:', reqs.length, ' byte dichiarati:', (totalBytes / 1e6).toFixed(2), 'MB');
console.log('ultima richiesta a ms:', reqs.length ? reqs[reqs.length - 1].t - t0 : 0);
console.log('\n-- per rotta (top 15) --');
for (const [k, v] of [...byPath].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(v).padStart(5), k);
console.log('\n-- URL IDENTICI ripetuti (top 15) --');
for (const [k, v] of [...dupFull].sort((a, b) => b[1] - a[1]).slice(0, 15)) { if (v > 1) console.log(String(v).padStart(5), k.slice(0, 110)); }
console.log('\n-- le 10 risposte piu pesanti --');
for (const r of [...reqs].sort((a, b) => b.len - a.len).slice(0, 10)) console.log(String((r.len / 1024).toFixed(0)).padStart(7), 'KB  @', r.t - t0, 'ms ', r.path);
await b.close();
