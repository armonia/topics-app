#!/usr/bin/env node
/**
 * IL CANCELLO: UNA FINESTRA FERMA NON SCRIVE.
 *
 * PERCHÉ ESISTE. Il 2026-08-19 una finestra di Topics lasciata ferma — nessun
 * gesto, nessun agente, niente sullo schermo che si muovesse — mandava al
 * server **un PUT da 75 KB ogni 1,15 secondi, per sempre**: 16 scritture in 25
 * secondi con l'unica differenza fra un corpo e il successivo che era `lastSeq`
 * (+2). Lo stato non cambiava mai.
 *
 * Non era «un po' di banda». Il server è Bun con `bun:sqlite` SINCRONO, quindi
 * ogni PUT è event loop FERMO per tutti; e su HTTP/1.1 occupa una delle SEI
 * connessioni che il browser concede per host, quindi si mette DAVANTI alle
 * letture che disegnano la board. È la ragione per cui un refresh sembrava
 * lento: misurato, la prima card della board compariva a 7.176 ms, contro i
 * 464 ms dopo il rimedio.
 *
 * LA CAUSA, per chi legge dopo: `UPDATE_PANE` faceva `{...pane, ...updates}`
 * senza confrontare, quindi produceva un oggetto nuovo anche a valori identici;
 * il dispatcher alza `lastSeq` a ogni dispatch; il middleware di sync guarda
 * `lastSeq` e manda. Tre anelli ragionevoli, un ciclo infinito.
 *
 * PERCHÉ UN CANCELLO E NON UN COMMENTO. Il rimedio vive in due punti distanti
 * (`reducers/panes.ts` e `middleware/syncServer.ts`) e i test unitari coprono
 * ciascuno per conto suo. Nessuno dei due, però, può dire «la finestra vera, a
 * riposo, sta zitta»: quella è una proprietà dell'app montata, e si osserva
 * soltanto da fuori. Senza questa misura il prossimo ciclo di scritture torna
 * senza far rumore — come questo, che è vissuto finché qualcuno non ha guardato.
 *
 * COSA MISURA. Apre la finestra, aspetta che il boot si posi, poi conta le
 * scritture (PUT/POST/PATCH verso `/api/`) in una finestra di osservazione a
 * schermo fermo. Il tetto è basso ma non zero: una scrittura sporadica è
 * legittima (l'ultima lettura di una chat, un heartbeat). Un CICLO no.
 *
 * QUELLO CHE HA GIÀ TROVATO, e che non è ancora chiuso. Tolto il ciclo di
 * `pane-store-v2`, sotto è emerso un SECONDO ciclo che il primo copriva:
 * `topics-project-panes-<hash>` (`state/pane/adapters/projectLayoutSync.ts`)
 * riscrive corpi IDENTICI — diffati due a due, nessuna differenza — a distanza
 * di 2,5-16 s. È più lento e sta dentro il tetto, quindi qui resta verde, ed è
 * la ragione per cui il tetto è 3 e non 0: un tetto a zero sarebbe rosso oggi
 * per un difetto diverso da quello che questo cancello sorveglia.
 *
 * Quel modulo ha già la guardia giusta (`lastSyncedJsonByKey`, confrontata
 * sul JSON serializzato) più un loop-breaker sull'idratazione, quindi la causa
 * non è l'assenza di un controllo: è qualcosa che svuota o aggira quella
 * memoria. Un candidato è `subscribeLifecycle('open')`, che la azzera a ogni
 * riconnessione del socket — ma nella misura fatta il 19/08 il socket si apriva
 * UNA volta sola, quindi non è quello, e va indagato a macchina scarica (quel
 * giorno il load medio era 124-221 per ffmpeg/Dia/Spotify, e in quelle
 * condizioni ogni misura di tempo mente).
 *
 * Uso:
 *   node scripts/check-idle-writes.mjs [--base https://localhost:3333]
 *                                      [--settle 12] [--watch 30] [--max 3]
 * Esce 1 se il tetto è superato, 2 se la finestra non si apre (infrastruttura,
 * non regressione: stessa convenzione degli altri cancelli di questo repo).
 */
import { webkit } from 'playwright';

const arg = (nome, def) => {
  const i = process.argv.indexOf('--' + nome);
  return i >= 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'https://localhost:3333');
const SETTLE_S = Number(arg('settle', 12));
const WATCH_S = Number(arg('watch', 30));
/**
 * Il tetto. Tre scritture in trenta secondi di schermo fermo: sopra questa
 * soglia non è più «ogni tanto succede qualcosa», è una cadenza. Il ciclo che
 * ha motivato il cancello ne faceva 26 nella stessa finestra.
 */
const MAX = Number(arg('max', 3));

const b = await webkit.launch().catch(() => null);
if (!b) {
  console.error('non parte il browser: WebKit di Playwright non disponibile');
  process.exit(2);
}
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();

const scritture = [];
p.on('request', (r) => {
  const m = r.method();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/')) return;
  scritture.push({ t: Date.now(), m, path: u.pathname });
});

try {
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
} catch {
  console.error(`la finestra non si apre su ${BASE} — il server è su?`);
  await b.close();
  process.exit(2);
}

console.log(`boot: aspetto ${SETTLE_S}s che si posi…`);
await p.waitForTimeout(SETTLE_S * 1000);

scritture.length = 0; // il boot ha diritto di scrivere: si misura ciò che viene DOPO
const t0 = Date.now();
console.log(`osservo ${WATCH_S}s a schermo fermo (tetto: ${MAX} scritture)…`);
await p.waitForTimeout(WATCH_S * 1000);
await b.close();

const perPath = new Map();
for (const s of scritture) {
  const k = `${s.m} ${s.path}`;
  perPath.set(k, (perPath.get(k) ?? 0) + 1);
}
console.log(`\nscritture a riposo: ${scritture.length} in ${WATCH_S}s`);
for (const [k, n] of [...perPath].sort((a, b) => b[1] - a[1])) {
  const q = scritture.filter((s) => `${s.m} ${s.path}` === k);
  const cadenza = q.length > 1
    ? ` — una ogni ${Math.round((q[q.length - 1].t - q[0].t) / (q.length - 1))}ms`
    : '';
  console.log(`  ${String(n).padStart(4)}x  ${k}${cadenza}`);
}

if (scritture.length > MAX) {
  console.error(
    `\n✗ ROSSO: ${scritture.length} scritture in ${WATCH_S}s a schermo fermo (tetto ${MAX}).`,
  );
  console.error(
    '  Una finestra ferma non deve scrivere a cadenza. Chi lo fa, di solito,\n' +
    '  dispaccia un\'azione che non cambia niente: il contatore sale, il\n' +
    '  middleware vede il contatore e manda. Vedi il commento in cima a questo\n' +
    '  file, e `reducers/panes.ts` → UPDATE_PANE.',
  );
  process.exit(1);
}
console.log(`\n✓ verde: ${scritture.length} ≤ ${MAX}`);
