#!/usr/bin/env bun
/**
 * Runs the COMPLETE `test:unit` suite in TWO PHASES, keeping EXACTLY the
 * coverage of the serial run (the same files) in a fraction of the wall-clock.
 *
 * THE PROBLEM (measured 05/09/2026). `bun test` has no file-level parallelism:
 * it runs the files one after the other in a single process. The pre-review
 * bar runs `test:unit` on EVERY card, and serially it costs ~462s nominal
 * (~7.7 min) and ~18 min under load. Most of that time is NOT CPU: ~121s of
 * real CPU drowned in ~340s of idle waiting (client tests wait on timers,
 * integration tests spawn servers and DBs and wait on I/O). One process leaves
 * 11 cores watching.
 *
 * WHY TWO PHASES AND NOT ONE POOL. `bun test` does not isolate files inside a
 * process: module singletons (`server/db` `_db`), `process.env` and the fake
 * DOM globals installed by tests LEAK from one file to the next. The suite is
 * green only in the canonical serial ORDER; any regrouping exposes those latent
 * leaks. Two classes really bit us:
 *   1. ORDER DEPENDENCE: a partial fake `window`/`localStorage`/`document` left
 *      on `globalThis` flips the `typeof window` guards of the files after it
 *      (e.g. `useMobile` -> `getComputedStyle is not defined`); a `_db` left
 *      open turns `initDatabase` into a no-op and skips the migrations ("no
 *      such table"). In the PARALLEL tier this class was closed at the root:
 *      every test that mounts a global unmounts it in `afterAll` (bun's baseline
 *      = no DOM globals), and the preload guard keeps it that way.
 *   2. RACES FOR OS RESOURCES: tests that spawn daemons and race for a free
 *      socket (`ai-bridge`) time out under CPU contention: 5 daemons fighting
 *      over a port while 4 shards hammer the cores is no longer the test you
 *      wanted. This class is not "isolated" away: it is racing by construction.
 *
 * WHAT IT DOES.
 *   PHASE 1 (parallel): ALMOST THE WHOLE suite (everything but the few OS racers
 *   of phase 2), split into N CONCURRENT `bun test` workers balanced by
 *   duration (LPT). Measured order-independent: 12 shuffled groupings x 4
 *   shards, 0 reds, both on the client tier and on `server/**` +
 *   `tests/integration`. The verdict does not depend on the grouping.
 *   PHASE 2 (serial): ONLY the racers with timing assertions (`ai-bridge*`, see
 *   SERIAL_GLOBS), in ONE `bun test` AFTER phase 1, so they run without CPU
 *   contention. A handful of files: the tail costs little.
 *
 * THE VERDICT is the aggregate: green only if EVERY phase-1 worker AND phase 2
 * are green. The stdout/stderr of every red phase is reprinted in full, so the
 * bar sees WHICH tests failed.
 *
 * THE DURATIONS (`test-unit-durations.json`, tracked in git like
 * `e2e-durations.json`) are rewritten ONLY with `--record`
 * (`bun run test:unit:durations`). The bare gate only reads them: if it
 * rewrote them on every run, every agent worktree would leave the gate with a
 * modified file, and the "clean tree" check or the land would carry it along.
 * A new file with no duration weighs the median.
 *
 * WHY IT IS SAFE. (1) It runs inside the ONE slot of `slot.ts` (label
 * `test:unit`): it sets `TOPICS_GATE_HELD` on the workers, so bun's preload
 * (`bun-test-preload`) does NOT queue them for a second slot: they are one
 * logical slot, not N. (2) The integration tests that open real ports use free
 * ports plus isolated `APP_DATA_DIR`s (guard `global-setup-no-prod-paths.test.ts`),
 * so two shards opening them together do not collide. (3) The safety net is
 * still CI, which runs the SERIAL `bun test:unit` on main: this script shortens
 * the run, it does not widen the trust. A rare grouping flake that escaped the
 * 12 groupings tried is still caught by CI.
 *
 * WHEN TO ADD A FILE TO PHASE 2. Only when it becomes flaky under parallelism
 * because of a real OS resource with timing assertions (like `ai-bridge*`): add
 * it to `SERIAL_GLOBS`, the denylist is the only lever, nothing else changes. Do
 * NOT serialize out of prudence: phase 2 is serial wall-clock, every file there
 * lengthens the run. The proof that a file does NOT belong in phase 2 is the
 * green shuffle x shard repro (see the header).
 *
 * USAGE
 *   bun run scripts/test-unit-shards.ts            # N = TOPICS_UNIT_SHARDS or 4
 *   TOPICS_UNIT_SHARDS=6 bun run scripts/test-unit-shards.ts
 * In production it enters from the bar as:
 *   bun run scripts/slot.ts test:unit -- 'bun run scripts/test-unit-shards.ts'
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir, loadavg, cpus } from "os";
import { GATE_HELD_ENV } from "./gate-slot.ts";

/**
 * How many shards, and how long a test may take, on THIS machine right now.
 *
 * WHY THE PLAN LOOKS AT THE LOAD. The bar is sized for a quiet box: four shards
 * on twelve cores, 30 s per test. Under a fleet it is not quiet: on 05/09/2026
 * the load sat at 46 on 12 cores (four agents, three gate slots each running
 * four shards, typecheck and lint beside them). At that pressure every test
 * runs ~4x slower, the 30 s cap turns into a clock, and two cards parked
 * themselves within an hour on "test:unit red, no red test in the report" -
 * a shard killed by timeouts on a branch identical to main. A gate that goes
 * red with the load measures the machine, not the code.
 *
 * So above a pressure of 1.25 (load per core) the run adds fewer processes
 * (shards divided by the pressure, never below two) and gives each test more
 * time (the cap multiplied by the pressure, at most 4x). Explicit env values
 * are respected: whoever set TOPICS_UNIT_SHARDS or TOPICS_TEST_TIMEOUT_MS
 * made a choice, and the plan does not overrule a person.
 */
export interface LoadPlan {
  shards: number;
  timeoutMs: number;
  /** load / cores, the number the two adjustments are driven by. */
  pressure: number;
  /** One line for the output when the plan changed; null on a quiet machine. */
  note: string | null;
}
export const LOAD_PRESSURE_FLOOR = 1.25;
export const LOAD_TIMEOUT_CAP = 4;
export function planUnderLoad(input: {
  load: number;
  cores: number;
  shards: number;
  timeoutMs: number;
  shardsExplicit?: boolean;
  timeoutExplicit?: boolean;
}): LoadPlan {
  const cores = Math.max(1, input.cores);
  const pressure = Math.max(0, input.load) / cores;
  if (!Number.isFinite(pressure) || pressure <= LOAD_PRESSURE_FLOOR) {
    return { shards: input.shards, timeoutMs: input.timeoutMs, pressure, note: null };
  }
  const shards = input.shardsExplicit ? input.shards : Math.max(2, Math.min(input.shards, Math.floor(input.shards / pressure)));
  const factor = Math.min(LOAD_TIMEOUT_CAP, pressure);
  const timeoutMs = input.timeoutExplicit ? input.timeoutMs : Math.round(input.timeoutMs * factor);
  const changed = shards !== input.shards || timeoutMs !== input.timeoutMs;
  const note = changed
    ? `carico ${input.load.toFixed(1)} su ${cores} core (pressione ${pressure.toFixed(2)}): ${shards} shard invece di ${input.shards}, timeout per test ${timeoutMs} ms invece di ${input.timeoutMs}`
    : null;
  return { shards, timeoutMs, pressure, note };
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const DURATIONS_PATH = resolve(import.meta.dir, "test-unit-durations.json");

/**
 * The roots `test:unit` runs (package.json). The enumeration MUST match what
 * `bun test <root>` would collect, or the sharded run covers less than the
 * serial one. Under these roots only `*.test.ts`/`*.test.tsx` exist (verified:
 * 1132 + 16), no `.spec`/`.js`/`_test`, so the glob matches.
 */
export const SUITE_ROOTS = [
  "client/src",
  "server",
  "shared",
  "relay",
  "tests/unit",
  "tests/integration",
  "scripts",
  "cli",
] as const;

/**
 * The files that MUST run serially in phase 2 (globs relative to `cwd`). No
 * longer "the whole heavy tier": measured on 05/09/2026, `server/**` +
 * `tests/integration/**` run order-INDEPENDENT across 12 shuffled groupings x 4
 * shards (0 reds). Most server tests open their own `new Database(":memory:")`
 * and never touch the `_db` singleton. So the heavy tier goes to phase 1
 * (parallel) like everything else.
 *
 * Only whoever races for a real OS resource with TIMING assertions stays in
 * phase 2: `ai-bridge-singleton` spawns 5 daemons fighting over a socket and
 * checks that exactly ONE is left listening within a deadline; under the CPU
 * contention of N shards that deadline slips (measured: timeout at 15221ms >
 * 15s). The socket is pid-scoped, so it is NOT a cross-shard race: it is
 * real-time-sensitive. In phase 2, with no contention, the timing holds.
 * `ai-bridge` is the same family (it spawns the mjs daemon) and is cheap: it
 * stays with it. Whoever turns flaky under parallelism is added here; the rest
 * of the code does not change.
 */
export const SERIAL_GLOBS = [
  "server/ai-bridge-singleton.test.ts",
  "server/ai-bridge.test.ts",
] as const;

const TEST_GLOBS = ["**/*.test.ts", "**/*.test.tsx"] as const;

/** The test files under the roots, as paths relative to `cwd`, sorted and unique. */
export function enumerateTestFiles(roots: readonly string[], cwd: string): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    for (const pattern of TEST_GLOBS) {
      const glob = new Bun.Glob(`${root}/${pattern}`);
      for (const rel of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
        seen.add(rel);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Splits the files into the two tiers: `serial` (matches one of `SERIAL_GLOBS`)
 * and `parallel` (everything else). The union is exactly `files`, so coverage
 * never changes because of the partition.
 */
export function partitionTiers(
  files: string[],
  serialGlobs: readonly string[] = SERIAL_GLOBS,
): { parallel: string[]; serial: string[] } {
  const matchers = serialGlobs.map((g) => new Bun.Glob(g));
  const parallel: string[] = [];
  const serial: string[] = [];
  for (const f of files) {
    if (matchers.some((m) => m.match(f))) serial.push(f);
    else parallel.push(f);
  }
  return { parallel, serial };
}

/** Known durations (seconds per file), written by a previous run. {} when absent. */
export function loadDurations(): Record<string, number> {
  if (!existsSync(DURATIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DURATIONS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** LPT: slowest to fastest, each into the bucket with the least load so far. */
export function planShards(
  files: string[],
  durations: Record<string, number>,
  shards: number,
): Array<{ files: string[]; seconds: number }> {
  const known = files.map((f) => durations[f]).filter((d): d is number => typeof d === "number" && d > 0);
  const sortedKnown = [...known].sort((a, b) => a - b);
  const median = sortedKnown.length ? sortedKnown[Math.floor(sortedKnown.length / 2)] : 1;

  const weighted = files
    .map((file) => ({ file, seconds: durations[file] ?? median }))
    .sort((a, b) => b.seconds - a.seconds);

  const buckets = Array.from({ length: Math.max(1, shards) }, () => ({ files: [] as string[], seconds: 0 }));
  for (const { file, seconds } of weighted) {
    let least = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].seconds < buckets[least].seconds) least = i;
    }
    buckets[least].files.push(file);
    buckets[least].seconds += seconds;
  }
  return buckets;
}

/**
 * Sums the `time` (seconds) of every `<testcase>` per `file`. The
 * `<testsuite file>` carries `time="0"` at file level in bun, so the real
 * duration is the sum of the testcases. Attributes can come in any order
 * (`time` before `file`), so they are extracted independently of the tag.
 */
export function parseJunitDurations(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  const tagRe = /<testcase\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    const file = /\bfile="([^"]*)"/.exec(tag)?.[1];
    const time = Number(/\btime="([^"]*)"/.exec(tag)?.[1]);
    if (!file || !Number.isFinite(time)) continue;
    out[file] = (out[file] ?? 0) + time;
  }
  return out;
}

/** One red test case as the junit report names it. */
export interface JunitFailure {
  file: string;
  /** `classname › name`, i.e. the describe path and the test title. */
  test: string;
}

/**
 * The test cases that carry a `<failure>` or `<error>` child.
 *
 * WHY THE SUMMARY NEEDS THEM. The whole output of a red shard is reprinted
 * above the summary, `(fail)` lines included, but the board keeps only the
 * TAIL of a check's output in the card comment: on 05/09/2026 the agent of
 * card 7bbefd9e read "test:unit exit 1" plus the reproduce line and had to
 * rerun the shard just to learn which test was red. The names go in the last
 * lines, where the comment keeps them. A hook timeout or a crashed process
 * leaves no red test case in the report: the summary says so instead of
 * printing nothing.
 */
export function parseJunitFailures(xml: string): JunitFailure[] {
  const out: JunitFailure[] = [];
  const caseRe = /<testcase\b([^>]*?)(?<!\/)>([\s\S]*?)<\/testcase>/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (!/<(failure|error)\b/.test(body)) continue;
    const file = /\bfile="([^"]*)"/.exec(attrs)?.[1] ?? "?";
    const name = decodeXmlAttr(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "?");
    const describePath = decodeXmlAttr(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    out.push({ file, test: describePath ? `${describePath} › ${name}` : name });
  }
  return out;
}

function decodeXmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Green (0) only if EVERY worker is green; otherwise the first non-zero code. */
export function aggregateVerdict(exitCodes: number[]): number {
  const failed = exitCodes.find((c) => c !== 0);
  return failed ?? 0;
}

// ── running one group of files in one `bun test` process ─────────────────────
interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  wallS: number;
  fileCount: number;
  measured: Record<string, number>;
  /** Red test cases named by the junit report; empty on a hook timeout or a crash. */
  failures: JunitFailure[];
}

/** Launches ONE `bun test` process on the given `files` and collects verdict + durations. */
async function runBunTest(
  files: string[],
  xmlPath: string,
  timeoutMs: number,
): Promise<RunResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(
    ["bun", "test", "--timeout", String(timeoutMs), "--reporter=junit", `--reporter-outfile=${xmlPath}`, ...files],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CI: "1",
        // Covers the children with the slot this process already holds: bun's
        // preload sees the marker and does NOT queue for a second slot.
        [GATE_HELD_ENV]: process.env[GATE_HELD_ENV] ?? "test-unit-shards",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let measured: Record<string, number> = {};
  let failures: JunitFailure[] = [];
  try {
    if (existsSync(xmlPath)) {
      const xml = readFileSync(xmlPath, "utf8");
      measured = parseJunitDurations(xml);
      failures = parseJunitFailures(xml);
    }
  } catch {
    /* incomplete xml: the old durations are kept for those files */
  }
  return { code, stdout, stderr, wallS: (Date.now() - t0) / 1000, fileCount: files.length, measured, failures };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const plan = planUnderLoad({
    load: loadavg()[0] ?? 0,
    cores: cpus().length || 1,
    shards: Math.max(1, Number(process.env.TOPICS_UNIT_SHARDS) || 4),
    timeoutMs: Number(process.env.TOPICS_TEST_TIMEOUT_MS) || 30000,
    shardsExplicit: Number(process.env.TOPICS_UNIT_SHARDS) > 0,
    timeoutExplicit: Number(process.env.TOPICS_TEST_TIMEOUT_MS) > 0,
  });
  if (plan.note) console.error(`test-unit-shards: ${plan.note}`);
  const shardsN = plan.shards;
  const timeoutMs = plan.timeoutMs;

  const files = enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
  if (files.length === 0) {
    console.error("test-unit-shards: no test file found under", SUITE_ROOTS.join(", "));
    process.exit(2);
  }

  const { parallel, serial } = partitionTiers(files);
  const durations = loadDurations();
  const xmlDir = mkdtempSync(join(tmpdir(), "topics-unit-shards-"));
  const started = Date.now();

  // ── PHASE 1: almost the whole suite in N concurrent shards ──────────────────
  const N = Math.min(shardsN, Math.max(1, parallel.length));
  const buckets = planShards(parallel, durations, N).filter((b) => b.files.length > 0);
  const phase1 = await Promise.all(
    buckets.map((bucket, i) => runBunTest(bucket.files, join(xmlDir, `p1-shard-${i}.xml`), timeoutMs)),
  );

  // ── PHASE 2: the serial ai-bridge racers (after phase 1: no CPU contention) ──
  // "No contention" holds for THIS run: the semaphore (`gate-slot.ts`, cores/4
  // slots) lets up to three bars run together, and another card's phase 1 can
  // hammer the cores while the ai-bridge singleton measures its 15 s deadline
  // here (measured 15.2 s under 4 workers). A clock red on a card that never
  // touched ai-bridge costs an agent turn: phase 2 is retried ONCE, and says
  // so. Phase 1 is not: a red there belongs to the code.
  let phase2 = serial.length
    ? await runBunTest(serial, join(xmlDir, "p2-serial.xml"), timeoutMs)
    : null;
  if (phase2 && phase2.code !== 0) {
    console.error(`\n───── fase2 seriale rossa (exit ${phase2.code}): i racer ai-bridge sono sensibili alla contesa CPU, riprovo una volta ─────`);
    if (phase2.stderr.trim()) console.error(phase2.stderr.trimEnd());
    phase2 = await runBunTest(serial, join(xmlDir, "p2-serial-retry.xml"), timeoutMs);
    console.error(`───── fase2 seriale, secondo tentativo: ${phase2.code === 0 ? "verde" : `ancora rossa (exit ${phase2.code})`} ─────`);
  }

  const totalWallS = (Date.now() - started) / 1000;

  // Reprint the whole output of every red phase: the bar must see WHICH tests
  // failed, not only that a phase is red.
  const reds: Array<{ label: string; r: RunResult; files: readonly string[] }> = [];
  phase1.forEach((r, i) => { if (r.code !== 0) reds.push({ label: `fase1 shard ${i}`, r, files: buckets[i].files }); });
  if (phase2 && phase2.code !== 0) reds.push({ label: "fase2 seriale", r: phase2, files: serial });
  for (const { label, r, files: shardFiles } of reds) {
    console.error(`\n───── ${label} FALLITO (exit ${r.code}, ${r.fileCount} file, ${r.wallS.toFixed(1)}s) ─────`);
    if (r.stderr.trim()) console.error(r.stderr.trimEnd());
    if (r.stdout.trim()) console.error(r.stdout.trimEnd());
    // A red that depends on the GROUPING (a file leaving a dirty global to the
    // next one) reproduces only with the same list in the same order: the plan
    // changes on every run, so the list is printed here or it is lost. On
    // 05/09 a shard went red on `getComputedStyle` and the shard's composition
    // could no longer be rebuilt.
    console.error(`\nriproduci: bun test --timeout ${timeoutMs} ${shardFiles.join(" ")}`);
  }

  // Summary.
  console.log("\n── test:unit shards (ibrido: fase1 parallela + fase2 seriale) ──");
  phase1.forEach((r, i) => {
    console.log(`  fase1 shard ${i}: ${r.code === 0 ? "ok " : "RED"}  ${r.fileCount} file  ${r.wallS.toFixed(1)}s`);
  });
  if (phase2) {
    console.log(`  fase2 seriale : ${phase2.code === 0 ? "ok " : "RED"}  ${phase2.fileCount} file  ${phase2.wallS.toFixed(1)}s`);
  }
  // The red tests BY NAME, last, and on STDERR: the board's check runner
  // concatenates stdout then stderr and keeps the tail, so the last lines of
  // stderr are the only lines an agent is sure to read (measured 05/09/2026 on
  // card ca44c550: the comment ended with the reproduce line and bun's own
  // "exited with code 1", the names printed on stdout never reached it).
  const MAX_NAMED = 12;
  for (const { label, r } of reds) {
    if (r.failures.length === 0) {
      console.error(`${label}: nessun test rosso nel referto junit — il rosso e' un hook scaduto, un crash o un timeout di processo: leggi l'output del shard qui sopra`);
      continue;
    }
    console.error(`${label}, test rossi (${r.failures.length}):`);
    for (const f of r.failures.slice(0, MAX_NAMED)) console.error(`  ✗ ${f.file} › ${f.test}`);
    if (r.failures.length > MAX_NAMED) console.error(`  … e altri ${r.failures.length - MAX_NAMED}`);
  }
  const codes = [...phase1.map((r) => r.code), ...(phase2 ? [phase2.code] : [])];
  const verdict = aggregateVerdict(codes);
  console.log(
    `  ${verdict === 0 ? "PASS" : "FAIL"}  ${files.length} file (${parallel.length} par / ${serial.length} ser) in ${N} shard  wall ${totalWallS.toFixed(1)}s` +
      (verdict === 0 ? "" : `  (exit ${verdict})`),
  );

  // Rewrite the measured durations only on request (merged over the old ones: a
  // file this run never reached keeps its previous estimate instead of vanishing).
  if (process.argv.includes("--record")) {
    const merged: Record<string, number> = { ...durations };
    for (const r of [...phase1, ...(phase2 ? [phase2] : [])]) {
      for (const [f, s] of Object.entries(r.measured)) merged[f] = s;
    }
    try {
      writeFileSync(DURATIONS_PATH, JSON.stringify(sortKeys(merged), null, 0) + "\n");
      console.log(`  durate aggiornate: ${Object.keys(merged).length} file → ${DURATIONS_PATH}`);
    } catch {
      /* durations are not critical: the next run uses the median */
    }
  }

  rmSync(xmlDir, { recursive: true, force: true });
  process.exit(verdict);
}

/** Sorted keys: the durations json stays a clean diff between runs. */
function sortKeys(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
