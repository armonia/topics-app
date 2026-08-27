#!/usr/bin/env bun
/**
 * LA MEMORIA DI UNA FINESTRA NEL TEMPO: cresce, o è già presa?
 *
 * PERCHÉ ESISTE. «Topics tiene 1,8 GB» è una fotografia, e una fotografia non
 * distingue le due diagnosi che chiedono rimedi opposti: memoria che CRESCE
 * (qualcuno accumula e non pota — si cerca chi) e memoria GIÀ PRESA e mai
 * restituita (si cerca cosa l'ha allocata, spesso all'avvio). Il 2026-07-29 il
 * WebContent teneva 1.844 MB con la curva PIATTA su cinque minuti, e piatta
 * voleva dire la seconda: due fix fatti sulla diagnosi sbagliata sono costati
 * una crescita di dodici volte e un ⌘R diventato caro (vedi `devHeapProbe`).
 *
 * COSA MISURA, e perché non `ps`. La metrica è `phys_footprint` — la colonna
 * «Memoria» di Monitoraggio Attività — perché include ciò che il sistema ha
 * compresso o mandato in swap, e su una macchina con 8,6 GB di swap occupato
 * (misurato qui il 19/08) l'RSS descrive il vuoto. E i processi WKWebView non
 * sono FIGLI dell'app: macOS li lega con la RESPONSABILITÀ, che è la relazione
 * che `scripts/mem-report.ts` già interroga. Questo script si appoggia a
 * quello, invece di ricopiarne la parte difficile.
 *
 * COME SI LEGGE. Una riga per campione, e alla fine la pendenza: MB al minuto
 * sulla seconda metà della serie (la prima metà è il boot, che alloca per
 * mestiere e sporcherebbe la retta). Sopra la soglia dichiarata è crescita, e
 * allora la domanda successiva è CHI — a cui risponde `devHeapProbe`, che
 * conta le entità invece di pesarle.
 *
 * Uso:  bun run scripts/mem-growth.ts [minuti] [--every 30]
 */
import { spawnSync } from "child_process";

const minuti = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 15);
const everyIdx = process.argv.indexOf("--every");
const EVERY_S = everyIdx >= 0 ? Number(process.argv[everyIdx + 1]) : 30;

interface Campione { t: number; deviceMB: number; serverMB: number; }

/** Una lettura di `mem-report --json`, che sa già trovare i WebView. */
function leggi(): { deviceMB: number; serverMB: number } | null {
  const r = spawnSync("bun", ["run", "scripts/mem-report.ts", "--json"], {
    encoding: "utf-8", cwd: import.meta.dir + "/..",
  });
  try {
    const j = JSON.parse(r.stdout);
    return { deviceMB: j?.device?.totalMB ?? 0, serverMB: j?.server?.totalMB ?? 0 };
  } catch { return null; }
}

const campioni: Campione[] = [];
const t0 = Date.now();
const fine = t0 + minuti * 60_000;
console.log(`misuro per ${minuti} min, un campione ogni ${EVERY_S}s — lascia la finestra FERMA`);
console.log(`${"min".padStart(6)}  ${"device MB".padStart(10)}  ${"server MB".padStart(10)}`);

while (Date.now() < fine) {
  const m = leggi();
  if (m) {
    campioni.push({ t: Date.now() - t0, ...m });
    const min = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(`${min.padStart(6)}  ${String(m.deviceMB).padStart(10)}  ${String(m.serverMB).padStart(10)}`);
  }
  await Bun.sleep(EVERY_S * 1000);
}

if (campioni.length < 4) {
  console.log("\ntroppo pochi campioni per dire qualcosa");
  process.exit(0);
}

/**
 * La pendenza sulla SECONDA METÀ. Il boot alloca per mestiere: includerlo
 * darebbe una retta in salita anche a un'app che poi resta ferma per ore, cioè
 * la risposta sbagliata alla domanda «cresce?».
 */
function pendenzaMBalMin(serie: Campione[], leggi: (c: Campione) => number): number {
  const s = serie.slice(Math.floor(serie.length / 2));
  if (s.length < 2) return 0;
  const n = s.length;
  const mx = s.reduce((a, c) => a + c.t, 0) / n;
  const my = s.reduce((a, c) => a + leggi(c), 0) / n;
  let num = 0, den = 0;
  for (const c of s) { num += (c.t - mx) * (leggi(c) - my); den += (c.t - mx) ** 2; }
  return den === 0 ? 0 : (num / den) * 60_000;
}

const dev = pendenzaMBalMin(campioni, (c) => c.deviceMB);
const srv = pendenzaMBalMin(campioni, (c) => c.serverMB);
const primo = campioni[0], ultimo = campioni[campioni.length - 1];
console.log(`\ndevice: ${primo.deviceMB} → ${ultimo.deviceMB} MB   pendenza ${dev.toFixed(2)} MB/min`);
console.log(`server: ${primo.serverMB} → ${ultimo.serverMB} MB   pendenza ${srv.toFixed(2)} MB/min`);
console.log(
  Math.abs(dev) < 1 && Math.abs(srv) < 1
    ? "\nCURVA PIATTA: la memoria è già presa, non è una crescita in corso.\n" +
      "  La domanda successiva non è «chi perde» ma «cosa l'ha allocata»."
    : "\nCRESCE: qualcuno accumula senza potare.\n" +
      "  Ora serve CHI: arma `devHeapProbe` (vedi il commento in quel file),\n" +
      "  che conta le entità vive invece di pesarle.",
);
