#!/usr/bin/env bun
/**
 * Records how long EVERY spec file took, so the shards can be balanced.
 *
 * WHY IT IS NEEDED. Playwright's `--shard=i/N` splits the files by TEST COUNT,
 * not by duration - it has no way of knowing what they cost. Measured on the
 * 30/07 run over 4 shards: 193s, 326s, 186s, 209s. Wall-clock is the maximum,
 * so the suite took 326 seconds while three machines out of four sat idle
 * waiting. With the durations known, LPT packing (`e2e-plan-shards.ts`) brings
 * the shards to within a few seconds of one another.
 *
 * HOW TO USE IT
 *   bun run scripts/e2e-record-durations.ts "$TMPDIR"/topics-e2e-shards/report-*.json
 *   bun run scripts/e2e-record-durations.ts test-results/uat-report.json
 *
 * MIND THE PATH. Until 25/08 this line read
 * `test-results/shard-*\/results.json`, which `e2e-shards.sh` no longer writes -
 * but those files STILL EXIST, days old. Following the old line does not fail:
 * it rebalances the plan on measurements from a different run, and the
 * imbalance that comes out of it looks like noise from the machine.
 *
 * Writes `scripts/e2e-durations.json`, which IS COMMITTED: without it the plan
 * would restart from scratch at every checkout and whoever launched the suite
 * first would pay the imbalance all over again. It is a heuristic, not a
 * contract - a missing or stale file breaks nothing (see the fallback in
 * `e2e-plan-shards.ts`).
 *
 * FROM A PARTIAL RUN: files not present in the JSON keep the duration they
 * already had. Recording one pass over five specs does not erase the other 103.
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

/** Sums per file the milliseconds of EVERY attempt (retries cost real time). */
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

// Merge onto the existing file: a partial run updates only the files it saw.
const previous: Record<string, number> = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, "utf8")) as Record<string, number>)
  : {};

const merged: Record<string, number> = { ...previous };
for (const [file, ms] of totals) merged[file] = Math.round(ms / 100) / 10; // seconds, 1 decimal

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
