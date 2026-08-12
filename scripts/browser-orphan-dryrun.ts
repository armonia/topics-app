#!/usr/bin/env bun
/**
 * Prova a vuoto della spazzata dei Chromium orfani, SENZA toccare niente.
 *
 * Monta `reapOrphanBrowsers` — la stessa funzione che gira all'avvio del
 * server — sul `ps` VERO di questa macchina, con un `kill` che registra invece
 * di sparare. Risponde alla domanda che i test unitari non possono chiudere:
 * su come sta messa questa macchina adesso, chi verrebbe ucciso?
 *
 * Uso:
 *   bun run browser:dryrun          # il piano, e niente altro
 *   bun run browser:dryrun --tutti  # più il censimento di OGNI chromium vivo
 *
 * Il secondo modo è quello che serve prima di fidarsi: elenca anche i chromium
 * che NON portano il nostro marchio (Playwright, jarvis-browser, quelli aperti
 * a mano) e dice esplicitamente che restano fuori. Ucciderli sarebbe peggio del
 * leak, quindi la lista di chi si salva conta quanto quella di chi muore.
 */

import { reapOrphanBrowsers, psSnapshot } from "../server/services/browser-orphan-reap";
import { parseProcSnapshot, parseBrowserMark, isChromiumHelper } from "../server/lib/browser-orphan-sweep";

const tutti = process.argv.includes("--tutti");

const raw = psSnapshot();
// Si ferma qui invece di proseguire su zero righe: un censimento che non ha
// guardato stamperebbe «niente da spazzare», che è la bugia più comoda.
if (raw === null) throw new Error("ps assente o fallito: nessun giudizio possibile su questa macchina.");

const rows = parseProcSnapshot(raw);
const chromium = rows.filter((r) => /chrom|Chrome|Chromium|Brave|Edge/i.test(r.command));

console.log(`ps: ${rows.length} processi · ${chromium.length} righe di famiglia chromium\n`);

const killed: number[] = [];
const res = reapOrphanBrowsers({
  snapshot: () => raw,
  kill: (pid) => killed.push(pid),
  ownPid: process.pid,
  // Sempre a vuoto: questo script non può sparare nemmeno sbagliando, perché
  // il `kill` che gli si passa scrive in un array.
  mode: "dry",
  log: (m) => console.log(m),
});

if (tutti) {
  console.log("\n— censimento di ogni chromium vivo —");
  const condannati = new Set(res.plan?.kill.map((k) => k.pid) ?? []);
  for (const r of chromium) {
    const mark = parseBrowserMark(r.command);
    const bin = r.command.split(" ")[0]!.split("/").pop() ?? "?";
    // Il crashpad si nomina a parte perché è la riga che inganna: gira con
    // ppid 1 e senza `--type=`, quindi da fuori sembra un browser abbandonato.
    // Non lo è: appartiene a un browser (spesso vivo), non dichiara nessun
    // profilo, e muore da solo quando muore il suo. Erano i due «helper con
    // ppid 1» che nella misura del 12/08 sembravano orfani.
    const che = /crashpad/i.test(bin) ? "crashpad" : isChromiumHelper(r.command) ? "helper" : "browser";
    const verdetto = condannati.has(r.pid)
      ? "SPAZZATO"
      : mark
        ? "nostro, si salva"
        : "non nostro, mai toccato";
    const chi = mark ? `${mark.role}:${mark.ownerPid}` : "senza marchio";
    console.log(`  ${String(r.pid).padStart(6)} ppid ${String(r.ppid).padStart(6)}  ${che.padEnd(7)} ${chi.padEnd(18)} ${verdetto.padEnd(24)} ${bin}`);
  }
}

console.log(
  `\nEsito: ${res.plan?.kill.length ?? 0} da spazzare, ${res.plan?.markedBrowsers ?? 0} chromium marchiati in vita. Nessun segnale inviato.`,
);
