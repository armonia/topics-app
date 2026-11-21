#!/usr/bin/env bun
/**
 * scripts/check-deadcode-prod.ts: ratchet on dead code measured in production.
 *
 * `check:deadcode` counts tests as users, so an export that only a test imports
 * is "used". `knip --production` drops the tests from the graph and says what
 * ships without a caller. Today that is not zero, so the gate is a ratchet: the
 * counts in `scripts/deadcode-prod-baseline.json` may fall, never rise.
 *
 *   bun run check:deadcode-prod            # exit 1 when a count rose
 *   bun run check:deadcode-prod --update   # write the new, lower counts
 *
 * Entries that ship carry `!` in knip.jsonc. Files that live only for tests
 * (harnesses, test kits) are listed in the `ignore` of the root workspace.
 */
import { join } from "node:path";

const BASELINE = join(import.meta.dir, "deadcode-prod-baseline.json");
const SECTIONS = { files: "Unused files", exports: "Unused exports", types: "Unused exported types" } as const;
type Counts = Record<keyof typeof SECTIONS, number>;

export function parseCounts(output: string): Counts {
  const counts = { files: 0, exports: 0, types: 0 };
  for (const key of Object.keys(SECTIONS) as (keyof Counts)[]) {
    const match = output.match(new RegExp(`^${SECTIONS[key]} \\((\\d+)\\)`, "m"));
    if (match) counts[key] = Number(match[1]);
  }
  return counts;
}

if (import.meta.main) {
  const knip = join(import.meta.dir, "..", "node_modules", ".bin", "knip-bun");
  const run = Bun.spawnSync([knip, "--production"], { stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  const now = parseCounts(output);
  if (run.exitCode !== 0 && now.files + now.exports + now.types === 0) {
    console.error(output);
    process.exit(1);
  }
  if (process.argv.includes("--update")) {
    await Bun.write(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log("baseline written", now);
    process.exit(0);
  }
  const base = (await Bun.file(BASELINE).json()) as Counts;
  const risen = (Object.keys(SECTIONS) as (keyof Counts)[]).filter((k) => now[k] > base[k]);
  if (risen.length > 0) {
    console.error(output);
    for (const k of risen) console.error(`production dead code rose: ${k} ${base[k]} -> ${now[k]}`);
    process.exit(1);
  }
  console.log("deadcode-prod ok", now, "baseline", base);
}
