#!/usr/bin/env bun
/**
 * I LAYER DEL COMPOSITORE DELLA FINESTRA VERA, contati nel tempo.
 *
 * PERCHÉ NON BASTAVA `check-layers.mjs`. Quello conta gli elementi che il CSS
 * promuove, letti da dentro la pagina — ed è la domanda giusta per capire CHI
 * promuove. Ma i byte non stanno lì: stanno nei backing IOSurface, che il
 * JavaScript non può vedere, e si contano solo da fuori con `vmmap`.
 *
 * E devono essere contati sulla FINESTRA VERA. Un tentativo di riprodurre il
 * fenomeno in un browser di prova è fallito due volte per la stessa ragione,
 * che vale la pena scrivere: `vmmap` sul processo di contenuto di Playwright
 * torna a mani vuote (il processo muore con la chiusura del browser, e la
 * lettura arriva dopo), quindi la misura usciva «+0 contro +0» — che sembra un
 * risultato negativo e invece è nessun risultato. Un numero che non poteva
 * cambiare non prova niente.
 *
 * COSA HA TROVATO. Sulla finestra dell'utente, aperta da quindici ore:
 *
 *     13:41  3.127 regioni      14:49  5.585      15:17  6.118
 *
 * cioè **+31 regioni al minuto, per novantasei minuti**, mentre `devHeapProbe`
 * misurava un DOM perfettamente PIATTO nella stessa finestra (1.864 nodi e 209
 * `<svg>`, invariati campione dopo campione) e la heap JS dichiarata restava
 * sotto il megabyte. Il contenuto non cresce; il suo backing grafico sì. 1,2 GB
 * di quelle regioni sono finiti in swap, ed è la ragione per cui la barra di
 * stato dice 1,6-2,2 GB.
 *
 * COME SI USA. Serve un PID: quello del processo di contenuto della finestra,
 * che `scripts/mem-report.ts` sa già trovare (i WKWebView non sono figli
 * dell'app, macOS li lega con la RESPONSABILITÀ). Senza argomenti lo cerca da
 * sé prendendo il `com.apple.WebKit.WebContent` più pesante.
 *
 *   bun run scripts/layer-growth.ts [pid] [--minuti 10] [--max-al-minuto 5]
 *
 * Esce 1 se i layer crescono oltre il tetto a finestra ferma, 2 se non misura.
 * IMPORTANTE: la finestra va lasciata FERMA per tutta la durata, altrimenti si
 * sta misurando l'uso, non la perdita.
 */
import { spawnSync } from "child_process";

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const MINUTI = Number(arg("minuti", "10"));
/**
 * Quante regioni al minuto si accettano. Non zero: aprire un menu, disegnare un
 * tooltip, un'animazione che parte creano layer legittimi, e su una finestra
 * usata il conto oscilla. Cinque al minuto è ampiamente sopra quel rumore e
 * ampiamente sotto le trentuno misurate.
 */
const MAX_AL_MINUTO = Number(arg("max-al-minuto", "5"));

/** Il numero di regioni `owned unmapped (graphics)`, o null se non leggibile. */
function regioni(pid: number): number | null {
  const r = spawnSync("/bin/bash", ["-lc", `vmmap ${pid} 2>/dev/null | grep -c 'owned unmapped (graphics)'`], { encoding: "utf-8" });
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Il footprint in MB, per dare al conteggio il suo peso. */
function footprintMB(pid: number): number | null {
  const r = spawnSync("/bin/bash", ["-lc", `vmmap -summary ${pid} 2>/dev/null | grep 'Physical footprint:'`], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/([\d.]+)([MGK])/);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n);
}

/** Il WebContent più PESANTE: su questa macchina è la finestra principale. */
function pidPiuPesante(): number | null {
  const r = spawnSync("/bin/bash", ["-lc",
    `ps -axo pid=,rss=,command= | grep 'WebKit.WebContent.xpc' | grep -v grep | sort -k2 -n -r | head -1 | awk '{print $1}'`,
  ], { encoding: "utf-8" });
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const esplicito = process.argv.find((a) => /^\d+$/.test(a) && Number(a) > 1000);
const pid = esplicito ? Number(esplicito) : pidPiuPesante();
if (!pid) {
  console.error("nessun processo di contenuto trovato: l'app è aperta?");
  process.exit(2);
}

const r0 = regioni(pid);
if (r0 === null) {
  console.error(`vmmap non legge il pid ${pid}: il processo è vivo? servono i permessi?`);
  process.exit(2);
}
const f0 = footprintMB(pid);
console.log(`pid ${pid} — t0: ${r0} regioni grafiche, ${f0} MB`);
console.log(`misuro per ${MINUTI} min — lascia la finestra FERMA\n`);

const t0 = Date.now();
let ultimo = r0;
for (let i = 1; i <= MINUTI; i++) {
  await Bun.sleep(60_000);
  const r = regioni(pid);
  if (r === null) {
    console.error(`\nil processo ${pid} non risponde più (chiuso? ricaricato?): misura interrotta`);
    process.exit(2);
  }
  ultimo = r;
  const f = footprintMB(pid);
  console.log(`t+${String(i).padStart(2)}m: ${r} regioni (${r - r0 >= 0 ? "+" : ""}${r - r0}) · ${f} MB`);
}

const minutiVeri = (Date.now() - t0) / 60_000;
const alMinuto = (ultimo - r0) / minutiVeri;
console.log(`\n${r0} → ${ultimo} regioni in ${minutiVeri.toFixed(1)} min = ${alMinuto.toFixed(1)}/min`);
if (alMinuto > MAX_AL_MINUTO) {
  console.error(`\n✗ ROSSO: ${alMinuto.toFixed(1)} regioni grafiche al minuto (tetto ${MAX_AL_MINUTO}).`);
  console.error(
    "  Ogni regione è un backing IOSurface che la heap JS non vede: si accumula\n" +
    "  fuori da ogni sonda scritta in JavaScript e finisce in swap. Se il DOM è\n" +
    "  piatto (`lib/devHeapProbe`) il contenuto non c'entra: qualcuno promuove a\n" +
    "  layer e non rilascia. `scripts/check-layers.mjs` dice chi promuove.",
  );
  process.exit(1);
}
console.log(`\n✓ verde: ${alMinuto.toFixed(1)}/min ≤ ${MAX_AL_MINUTO}`);
