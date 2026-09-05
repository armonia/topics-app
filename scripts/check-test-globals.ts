#!/usr/bin/env bun
/**
 * WHO LEAVES A FAKE DOM GLOBAL TO THE NEXT FILE.
 *
 * THE FAULT. `bun test` runs every file of a run in ONE process: a
 * `globalThis.window = { localStorage }` installed by a test and never removed
 * stays there for every file after it. A component rendered later passes the
 * `typeof window !== "undefined"` guard, calls `getComputedStyle`, and the
 * global is not there: `ReferenceError`. Measured on 05/09/2026: 10 files out
 * of 1149 left `window`/`localStorage`/`requestAnimationFrame` behind, and
 * `dispatchedEnvelope.test.tsx` went red ONLY when the shard's grouping placed
 * it after one of them: a red the triage on the single file never reproduces.
 *
 * WHAT IT DOES. It runs EVERY test file on its own, under the suite's own
 * preload (`tests/setup/bun-test-preload.ts`), whose end-of-run guard exits red
 * when a DOM global appeared and was not removed. A file alone = the run holds
 * only that file = the culprit is that file. It reports the list with the
 * globals each one left behind.
 *
 * WHEN TO USE IT. When the preload guard turned a shard or the whole suite red
 * ("leaked DOM globals"): the guard says THAT somebody leaked, not WHO; this
 * says who. With a suspect in hand, `bun test <file>` on its own is enough:
 * the same guard runs there.
 *
 *   bun run check:test-globals              # the whole suite (~80s, 6 processes)
 *   bun run check:test-globals a.test.ts …  # only those files
 *
 * It is NOT a gate: it is triage. It does not go through the semaphore
 * (`TOPICS_GATE_HELD` on the children) because its processes are short and the
 * scan is launched by hand.
 */
import { enumerateTestFiles, SUITE_ROOTS } from "./test-unit-shards.ts";
import { GATE_HELD_ENV } from "./gate-slot.ts";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
/** The signature the preload guard prints (`DOM_LEAK_MARKER`): changing it there means changing it here. */
const LEAK_MARKER = /leaked DOM globals: (\S+)/;

const requested = process.argv.slice(2);
const files = requested.length ? requested : enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
const parallel = Math.max(1, Number(process.env.TOPICS_CHECK_GLOBALS_PARALLEL) || 6);
console.error(`check:test-globals: ${files.length} file(s), ${parallel} at a time`);

const leaks: Array<{ file: string; keys: string }> = [];
const otherReds: string[] = [];
let done = 0;
const started = Date.now();

async function runAlone(file: string): Promise<void> {
  const proc = Bun.spawn(["bun", "test", "--timeout", "30000", file], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "1", [GATE_HELD_ENV]: "check:test-globals" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const m = LEAK_MARKER.exec(stderr);
  if (m) leaks.push({ file, keys: m[1] });
  else if (code !== 0) otherReds.push(`${file} (exit ${code})`);
  done += 1;
  if (done % 100 === 0) console.error(`  ${done}/${files.length}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

const queue = [...files];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (queue.length) await runAlone(queue.shift()!);
  }),
);

if (leaks.length) {
  console.log(`\n${leaks.length} file(s) leave DOM globals to the next file:`);
  for (const { file, keys } of leaks.sort((a, b) => a.file.localeCompare(b.file))) console.log(`  ${file}  →  ${keys}`);
  console.log("\nFix: in `afterAll`/`afterEach` put back what the file found (`delete globalThis.window`, etc.).");
} else {
  console.log(`\nno file leaves DOM globals (${files.length} checked)`);
}
if (otherReds.length) {
  console.log(`\n${otherReds.length} file(s) red for other reasons (not this scan's business):`);
  for (const r of otherReds) console.log(`  ${r}`);
}
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exit(leaks.length ? 1 : 0);
