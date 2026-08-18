#!/usr/bin/env bun
/**
 * Server typecheck RATCHET.
 *
 * The server runs on Bun with no build-time tsc step, so type errors piled up
 * unchecked (AUDIT-2026-06-19.md priority #3). Fixing all of them at once was
 * judged risky on hot paths, so the count was grandfathered and forbidden from
 * rising: CI fails if a change introduces a NEW server type error.
 *
 * The backlog is gone and the config is now FULL `strict`, with the *.test.ts
 * files included (they had been excluded, leaving ~21k lines outside every
 * gate). BASELINE is 0 and this is a hard gate. Keep it there.
 */
import { spawnSync } from "node:child_process";

// Server type errors must stay at zero (tsconfig.server.json). Do NOT raise
// this to make CI green — fix the new error instead.
const BASELINE = 0;

const TSC = "./client/node_modules/.bin/tsc";
const res = spawnSync(
  TSC,
  ["-p", "tsconfig.server.json", "--ignoreDeprecations", "5.0"],
  { encoding: "utf8" },
);

const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
const count = (out.match(/error TS\d+/g) ?? []).length;

if (out) console.log(out);

// A gate that never ran is not a green gate. If spawnSync could not launch the
// binary (missing node_modules — i.e. ANY fresh worktree without `bun install`
// in client/) it sets res.error and leaves status null, stdout/stderr empty:
// the regex finds 0 errors and this script used to print "0 (baseline 0)" and
// exit 0. Fail loudly instead.
if (res.error || res.status === null) {
  console.error(
    `\n✗ tsc non trovato o non eseguibile in ${TSC}` +
      `${res.error ? ` (${res.error.message})` : ""}.\n` +
      `  Il typecheck NON è girato: esegui \`bun install\` in client/.`,
  );
  // 97 = NON MISURATO, non «fallito». La distinzione c'era gia' a parole qui
  // sopra, ma l'uscita 1 la buttava via: chi legge l'esito vede il numero, e la
  // card scriveva `checks_state = 'fail'` — «il tuo codice e' rotto» su un
  // worktree senza dipendenze. Vedi `scripts/check-client-deps.ts`.
  process.exit(97);
}

// tsc failed for a reason the regex cannot see (bad tsconfig, crash, OOM):
// also a gate that did not measure what it claims to measure.
if (res.status !== 0 && count === 0) {
  console.error(
    `\n✗ tsc è uscito ${res.status} senza stampare alcun 'error TSxxxx'. ` +
      `Il conteggio non è attendibile: guarda l'output sopra.`,
  );
  process.exit(1);
}
console.log(`\nserver type errors: ${count} (baseline ${BASELINE})`);

if (count > BASELINE) {
  console.error(
    `\n✗ Server type errors rose ${BASELINE} → ${count}. ` +
      `Fix the new error(s) above — do not raise the baseline.`,
  );
  process.exit(1);
}
if (count < BASELINE) {
  console.log(
    `\n✓ ${BASELINE - count} below baseline. Lower BASELINE in ` +
      `scripts/typecheck-server.ts to ${count} to lock the win.`,
  );
}
process.exit(0);
