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
