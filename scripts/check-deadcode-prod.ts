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
 * Entries that ship carry `!` in knip.jsonc. Development scripts and the UI
 * gallery (built to dist-ui, no workflow runs it) do not: they are not production. Files that live only for tests
 * (harnesses, test kits) are excluded from `project` with `!...!` in knip.jsonc.
 *
 * The 596 baseline as of 2026-11-22, traced one directory at a time (checked
 * with `bun run check:deadcode`, which counts tests and the gallery as users
 * and reports zero): 241 are `client/src/ui-gallery/**`, 354 are
 * `client/src/ui/**` (the design-system components, copy and demo fixtures
 * the gallery renders — a work in progress, last touched the same day),
 * and 1 is `server/agents/persona-migrate.ts`, reached only by
 * `scripts/migrate-principal-soul.ts` (a hand-run script, so not a `!` entry).
 * None of the 596 is an orphan nobody imports: every one is live through the
 * gallery, its fixtures, or a test, which is why there is nothing here to
 * delete today without breaking that work. The count falls only as pieces of
 * `client/src/ui` get wired into real app components (`PeopleUsageBox.tsx`
 * already pulls two from `ui/primitives`), not by pruning this tree by hand.
 */
import { join } from "node:path";

const BASELINE = join(import.meta.dir, "deadcode-prod-baseline.json");
const SECTIONS = { files: "Unused files", exports: "Unused exports", types: "Unused exported types" } as const;
type Counts = Record<keyof typeof SECTIONS, number>;

/**
 * Reads the three counts out of knip's report. A clean run prints nothing and
 * exits 0, so no section is fine then. A failing run with none of the sections
 * means the format changed (or knip crashed): reading that as "0 dead" would
 * let the gate pass blind, so it throws instead.
 */
export function parseCounts(output: string, exitCode: number): Counts {
  const counts = { files: 0, exports: 0, types: 0 };
  let found = false;
  for (const key of Object.keys(SECTIONS) as (keyof Counts)[]) {
    const match = output.match(new RegExp(`^${SECTIONS[key]} \\((\\d+)\\)`, "m"));
    if (match) {
      counts[key] = Number(match[1]);
      found = true;
    }
  }
  if (exitCode !== 0 && !found) throw new Error("knip exited non-zero without a known 'Unused ...' section");
  return counts;
}

if (import.meta.main) {
  const deadCodeBin = join(import.meta.dir, "..", "node_modules", ".bin", "knip-bun");
  const run = Bun.spawnSync([deadCodeBin, "--production"], { stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  let now: Counts;
  try {
    now = parseCounts(output, run.exitCode);
  } catch (err) {
    console.error(output);
    console.error((err as Error).message);
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
