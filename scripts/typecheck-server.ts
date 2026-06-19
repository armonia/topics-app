#!/usr/bin/env bun
/**
 * Server typecheck RATCHET.
 *
 * The server runs on Bun with no build-time tsc step, so type errors piled up
 * unchecked (AUDIT-2026-06-19.md priority #3). Fixing all of them at once is
 * risky on hot paths, so instead we grandfather the current count and forbid it
 * from rising: CI fails if a change introduces a NEW server type error.
 *
 * Burn the baseline DOWN as errors get fixed (the script tells you when to);
 * never raise it. Reaching 0 means we can flip `strict` on and gate hard.
 */
import { spawnSync } from "node:child_process";

// Known pre-existing server type errors (tsconfig.server.json, 2026-06-19).
// Lower this when you fix some; do NOT raise it to make CI green.
const BASELINE = 27;

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
