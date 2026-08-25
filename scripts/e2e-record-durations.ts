#!/usr/bin/env bun
/**
 * Registra quanto ha impiegato OGNI file di spec, per bilanciare gli shard.
 *
 * PERCHÉ SERVE. `--shard=i/N` di Playwright distribuisce i file per NUMERO DI
 * TEST, non per durata — non ha modo di sapere quanto costano. Misurato sulla
 * run del 30/07 a 4 shard: 193s, 326s, 186s, 209s. Il wall-clock è il massimo,
 * quindi la suite finiva in 326 secondi mentre tre macchine su quattro
 * aspettavano ferme. Con le durate note il pacchettamento LPT
 * (`e2e-plan-shards.ts`) porta gli shard a pochi secondi l'uno dall'altro.
 *
 * COME SI USA
 *   bun run scripts/e2e-record-durations.ts "$TMPDIR"/topics-e2e-shards/report-*.json
 *   bun run scripts/e2e-record-durations.ts test-results/uat-report.json
 *
 * ATTENZIONE AL PERCORSO. Fino al 25/08 questa riga diceva
 * `test-results/shard-*\/results.json`, che `e2e-shards.sh` non scrive piu' — ma
 * quei file ESISTONO ANCORA, vecchi di giorni. Seguire la vecchia riga non
 * fallisce: ribilancia il piano su misure di un'altra corsa, e lo sbilanciamento
 * che ne esce sembra rumore della macchina.
 *
 * Scrive `scripts/e2e-durations.json`, che è COMMITTATO: senza, il piano
 * ripartirebbe da zero a ogni checkout e il primo che lancia la suite pagherebbe
 * di nuovo lo sbilanciamento. È un'euristica, non un contratto — un file
 * mancante o stantìo non rompe niente (vedi il fallback in `e2e-plan-shards.ts`).
 *
 * DA UN RUN PARZIALE: i file non presenti nel JSON conservano la durata che
 * avevano. Registrare una passata su cinque spec non cancella le altre 103.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

const OUT = resolve(import.meta.dir, "e2e-durations.json");

type PlaywrightJson = {
  suites?: PwSuite[];
};
type PwSuite = {
  file?: string;
  suites?: PwSuite[];
  specs?: Array<{
    file?: string;
    tests?: Array<{ results?: Array<{ duration?: number }> }>;
  }>;
};

/** Somma per file i millisecondi di TUTTI i tentativi (i retry costano tempo reale). */
function collect(json: PlaywrightJson, into: Map<string, number>): void {
  const walk = (suite: PwSuite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file;
      if (!file) continue;
      for (const t of spec.tests ?? [])
        for (const r of t.results ?? [])
          into.set(file, (into.get(file) ?? 0) + (r.duration ?? 0));
    }
  };
  for (const s of json.suites ?? []) walk(s);
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error(
    "uso: bun run scripts/e2e-record-durations.ts <results.json> [results.json …]\n" +
      "     (tipicamente $TMPDIR/topics-e2e-shards/report-*.json dopo ./scripts/e2e-shards.sh)",
  );
  process.exit(2);
}

const totals = new Map<string, number>();
let read = 0;
for (const path of inputs) {
  if (!existsSync(path)) {
    console.error(`[durations] salto ${path}: non esiste`);
    continue;
  }
  try {
    collect(JSON.parse(readFileSync(path, "utf8")) as PlaywrightJson, totals);
    read++;
  } catch (err) {
    console.error(`[durations] salto ${path}: JSON illeggibile (${(err as Error).message})`);
  }
}

if (read === 0 || totals.size === 0) {
  console.error("[durations] nessun risultato utilizzabile — non scrivo nulla.");
  process.exit(1);
}

// Merge sul file esistente: una run parziale aggiorna solo i file che ha visto.
const previous: Record<string, number> = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, "utf8")) as Record<string, number>)
  : {};

const merged: Record<string, number> = { ...previous };
for (const [file, ms] of totals) merged[file] = Math.round(ms / 100) / 10; // secondi, 1 decimale

const sorted = Object.fromEntries(
  Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");

const updated = totals.size;
const kept = Object.keys(merged).length - updated;
const total = Object.values(merged).reduce((a, b) => a + b, 0);
console.log(
  `[durations] ${OUT.replace(dirname(import.meta.dir) + "/", "")}: ` +
    `${updated} file aggiornati, ${kept} conservati, ${Object.keys(merged).length} in totale ` +
    `(${total.toFixed(0)}s di lavoro).`,
);
