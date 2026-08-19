#!/usr/bin/env node
/**
 * QUANTO COSTA UNA FINESTRA, appena aperta e dopo un po' di vita.
 *
 * PERCHÉ ESISTE. La finestra vera dell'utente teneva 1.346 MB dopo quattordici
 * ore e mezzo, con la curva PIATTA (misurato con `mem-growth.ts`: 1412 → 1446
 * MB in nove minuti). Piatta vuol dire che non c'è nessuna perdita in corso da
 * inseguire — ma NON dice se quel numero sia il prezzo giusto: una finestra che
 * nasce già a 1,3 GB e una che ci arriva in dieci ore sono due difetti diversi,
 * e nessuna misura fatta su una finestra sola può distinguerli.
 *
 * Questo attrezzo apre una finestra PULITA e la pesa: il numero che ne esce è
 * il costo di partenza, e la differenza con la finestra vera è ciò che il tempo
 * (e l'uso) hanno aggiunto. È l'unica forma in cui «1,3 GB» diventa una frase
 * con un soggetto.
 *
 * COSA MISURA E COSA NO. Pesa il processo di contenuto del browser di prova,
 * che è lo stesso motore della shell (WebKit) ma non la stessa build: i numeri
 * assoluti NON sono confrontabili con quelli di `mem-report.ts`. Ciò che si
 * confronta è la DIFFERENZA fra due stati dello stesso browser — appena
 * aperta, e dopo N minuti di vita — che è la domanda a cui serve rispondere.
 *
 * Uso:  node scripts/window-cost.mjs [--vivi 3] [--base URL]
 */
import { webkit } from 'playwright';
import { execSync } from 'child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://localhost:3333');
const VIVI_MIN = Number(arg('vivi', 3));

/**
 * `phys_footprint` di un processo, in MB. È la colonna «Memoria» di
 * Monitoraggio Attività, e include ciò che il sistema ha compresso o mandato in
 * swap: su questa macchina (8,6 GB di swap occupato) l'RSS descriverebbe il
 * vuoto lasciato, non la memoria che il processo tiene.
 */
function footprintMB(pid) {
  try {
    const out = execSync(`vmmap -summary ${pid} 2>/dev/null | grep 'Physical footprint:'`, { encoding: 'utf-8' });
    const m = out.match(/([\d.]+)([MGK])/);
    if (!m) return null;
    const n = Number(m[1]);
    return Math.round(m[2] === 'G' ? n * 1024 : m[2] === 'K' ? n / 1024 : n);
  } catch { return null; }
}

/** I processi di contenuto WebKit nati DOPO un certo istante: i nostri. */
function contentPids(dopoIso) {
  try {
    const out = execSync(
      `ps -axo pid,lstart,comm | grep -i 'WebKit.WebContent' | grep -v grep`,
      { encoding: 'utf-8' },
    );
    return out.trim().split('\n').filter(Boolean).map((r) => {
      const pid = Number(r.trim().split(/\s+/)[0]);
      const started = Date.parse(r.trim().split(/\s+/).slice(1, 6).join(' '));
      return { pid, started };
    }).filter((x) => x.started >= dopoIso);
  } catch { return []; }
}

const nascita = Date.now() - 2000;
const b = await webkit.launch().catch(() => null);
if (!b) { console.error('WebKit di Playwright non disponibile'); process.exit(2); }
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
try {
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
} catch {
  console.error(`la finestra non si apre su ${BASE}`);
  await b.close();
  process.exit(2);
}
await p.waitForTimeout(15_000); // il boot deve posarsi prima di pesarlo

/** Pesa i nostri processi di contenuto e li somma. */
const pesa = () => contentPids(nascita).map((x) => footprintMB(x.pid)).filter(Boolean);

const appena = pesa();
const totAppena = appena.reduce((a, b) => a + b, 0);
/** Il DOM e la heap dichiarata, per dare un ordine di grandezza a chi guarda. */
const dom = await p.evaluate(() => ({
  nodi: document.getElementsByTagName('*').length,
  svg: document.querySelectorAll('svg').length,
  img: document.querySelectorAll('img').length,
  canvas: document.querySelectorAll('canvas').length,
}));
console.log(`appena aperta:  ${totAppena} MB  (${appena.length} processi di contenuto)`);
console.log(`  DOM: ${dom.nodi} nodi · ${dom.svg} svg · ${dom.img} img · ${dom.canvas} canvas`);

console.log(`\nla lascio vivere ${VIVI_MIN} min, ferma…`);
await p.waitForTimeout(VIVI_MIN * 60_000);
const dopo = pesa();
const totDopo = dopo.reduce((a, b) => a + b, 0);
const domDopo = await p.evaluate(() => ({
  nodi: document.getElementsByTagName('*').length,
  svg: document.querySelectorAll('svg').length,
}));
await b.close();

console.log(`dopo ${VIVI_MIN} min:  ${totDopo} MB   (${totDopo - totAppena >= 0 ? '+' : ''}${totDopo - totAppena} MB)`);
console.log(`  DOM: ${domDopo.nodi} nodi (${domDopo.nodi - dom.nodi >= 0 ? '+' : ''}${domDopo.nodi - dom.nodi}) · ${domDopo.svg} svg (${domDopo.svg - dom.svg >= 0 ? '+' : ''}${domDopo.svg - dom.svg})`);
console.log(
  '\nDa leggere così: il primo numero è il PREZZO DI PARTENZA di una finestra,\n' +
  'il secondo quanto le costa restare aperta senza che nessuno la tocchi.\n' +
  'Se il DOM cresce a schermo fermo, qualcuno monta nodi e non li smonta —\n' +
  'e allora la domanda «chi» ha una risposta: `lib/devHeapProbe`.',
);
