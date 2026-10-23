#!/usr/bin/env bun
/**
 * THE UNIT SUITE: ONE `bun test` PROCESS PER FILE, N FILES AT A TIME.
 *
 * THE FAULT THIS REMOVES. `bun test` runs every file of a run in ONE process,
 * so what a file leaves behind is handed to the next one: DOM globals, a
 * `mock.module` that `mock.restore()` does not take back, `DATA_DIR`, the
 * `SOCKET_PATH` of the pty bridge, a throttle timer in flight, the `_db`
 * singleton. The verdict of a file then depended on its neighbours, and the
 * neighbours depended on how the run was cut: two in-process shard attempts
 * were faster (4.7 and 6.8 min) and red on tests that were green serially,
 * never the same ones. Three gates existed only to contain that
 * (check:module-mock-restore, check:test-globals, the DATA_DIR restore test),
 * each one a defence per class of leak, downstream of the leak.
 *
 * WHAT IT DOES INSTEAD. Every file gets its own process and its own scratch
 * directory (`TMPDIR`), so a global, a mock, an env var, a timer or a file in
 * the temp folder cannot reach another file: the defect is not representable
 * any more, so nothing has to detect it. The files go through a shared queue,
 * longest first, to N workers (the "shards"): a worker that finishes early
 * takes the next file instead of waiting for a plan made from durations
 * recorded on another machine.
 *
 * WHAT IT DOES NOT ISOLATE: the CPU. N processes still compete for the cores
 * and a test with a fixed time window can still starve (`TOPICS_TEST_TIME_SLACK`
 * widens those windows, `SERIAL_GLOBS` keeps the real OS racers alone at the
 * end).
 *
 * NOTHING STAYS IN THE TEMP FOLDER. A test that makes a folder in the temp dir
 * and never removes it used to pile up there (on 23/10/2026 the owner's Mac
 * held ~11,000 `topics-cred*`, 4,800 `topics*`, 3,500 `tracker-home*` and
 * `import*`). Each file's scratch directory is removed when the file ends,
 * whatever it left in it, so a leak cannot outlive its file; and on CI the run
 * also fails if anything appeared in the real temp folder in spite of it (a
 * hard-coded path). A plain `bun test` gets the same from the preload.
 *
 * ORDER. By default the longest files first. `--shuffle[=seed]` randomizes it
 * and prints the seed: with a process per file the order must not matter, and a
 * run that disagrees with another on the same tree is an OS-level shared
 * resource (a fixed port, a path outside the temp folder) and not a mock.
 *
 * THE DURATIONS (`test-unit-durations.json`, tracked in git) are rewritten ONLY
 * with `--record` (`bun run test:unit:durations`): a gate that rewrites a
 * tracked file leaves every agent worktree dirty. A file with no duration
 * weighs the median. They are wall times of the whole process, startup
 * included: that is what a worker spends.
 *
 * USAGE
 *   bun run scripts/test-unit-shards.ts                 # whole suite, N = TOPICS_UNIT_SHARDS or defaultShards(cores)
 *   bun run scripts/test-unit-shards.ts --shuffle=7     # random order, seed 7
 *   bun run scripts/test-unit-shards.ts <file|dir>...   # only these (they REPLACE the default roots)
 *   bun run scripts/test-unit-shards.ts --list          # the plan, one file per line, without running it
 * In production it enters from the bar as:
 *   bun run scripts/slot.ts test:unit -- 'bun run scripts/test-unit-shards.ts'
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { resolve, join } from "path";
import { tmpdir, loadavg, cpus } from "os";
import { randomBytes } from "crypto";
import { GATE_HELD_ENV } from "./gate-slot.ts";
import { clampSlowdown, gateSlowdownLine } from "../shared/gate-slowdown.ts";
import { TIME_SLACK_ENV, timeSlack, timeSlackNote } from "../shared/test-time-slack.ts";
import { TEST_RUN_ENV, newTestRunId, reportAndEndStrays, strayAiBridges } from "./stray-ai-bridges.ts";
import { gitIsolationEnv } from "../tests/setup/git-isolation";
import { PRIVATE_SCRATCH_ENV } from "../tests/setup/test-tmp-dirs.ts";

/**
 * How many shards to run on THIS machine, with the serial suite's timeout.
 *
 * WHY THE PLAN LOOKS AT THE LOAD. The bar was sized for a quiet box: four shards
 * on twelve cores, 30 s per test. Under a fleet it is not quiet: on 05/09/2026
 * the load sat at 46 on 12 cores (four agents, three gate slots each running
 * four shards, typecheck and lint beside them). At that pressure every test
 * runs ~4x slower, the 30 s cap turns into a clock, and two cards parked
 * themselves within an hour on "test:unit red, no red test in the report" -
 * a shard killed by timeouts on a branch identical to main. A gate that goes
 * red with the load measures the machine, not the code.
 *
 * Above a pressure of 1.25 (load per core) the run adds fewer processes
 * (shards divided by the pressure, never below one). The per-test timeout is
 * unchanged: parallel execution must not turn a serial timeout failure green.
 * Explicit TOPICS_UNIT_SHARDS and TOPICS_TEST_TIMEOUT_MS remain authoritative.
 */
export interface LoadPlan {
  shards: number;
  timeoutMs: number;
  /** load / cores, the number the two adjustments are driven by. */
  pressure: number;
  /**
   * How much longer this plan expects to take than the nominal one, as a
   * multiple: the parallelism it gave up (4 shards -> 2 is 2x wall clock, the
   * work being the same). Declared to whoever times this run from OUTSIDE under
   * a cap of its own, see shared/gate-slowdown.ts; 1 when nothing changed.
   */
  slowdown: number;
  /** One line for the output when the plan changed; null on a quiet machine. */
  note: string | null;
}
/**
 * How many shards a run takes when nobody asked: one per core, never fewer than
 * two nor more than four. The load plan below still takes shards away under
 * pressure, and TOPICS_UNIT_SHARDS=1 gives the strictly serial run.
 */
export function defaultShards(cores: number): number {
  return Math.max(2, Math.min(4, Math.floor(cores)));
}
export const LOAD_PRESSURE_FLOOR = 1.25;
export function planUnderLoad(input: {
  load: number;
  cores: number;
  shards: number;
  timeoutMs: number;
  shardsExplicit?: boolean;
}): LoadPlan {
  const cores = Math.max(1, input.cores);
  const pressure = Math.max(0, input.load) / cores;
  if (!Number.isFinite(pressure) || pressure <= LOAD_PRESSURE_FLOOR) {
    return { shards: input.shards, timeoutMs: input.timeoutMs, pressure, slowdown: 1, note: null };
  }
  const shards = input.shardsExplicit ? input.shards : Math.max(1, Math.min(input.shards, Math.floor(input.shards / pressure)));
  const timeoutMs = input.timeoutMs;
  const changed = shards !== input.shards;
  // Only the shards move the WALL CLOCK: the per-test cap is a ceiling on a
  // single test, not time anybody spends. The same files across half the
  // workers take about twice as long, and that is the number to declare.
  const slowdown = clampSlowdown(input.shards / Math.max(1, shards));
  const note = changed
    ? `carico ${input.load.toFixed(1)} su ${cores} core (pressione ${pressure.toFixed(2)}): ${shards} shard invece di ${input.shards}, timeout per test invariato (${timeoutMs} ms)`
    : null;
  return { shards, timeoutMs, pressure, slowdown, note };
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const DURATIONS_PATH = resolve(import.meta.dir, "test-unit-durations.json");

/**
 * The roots `test:unit` runs (package.json). The enumeration MUST match what
 * `bun test <root>` would collect, or the run covers less than the suite.
 * Under these roots only `*.test.ts`/`*.test.tsx` exist.
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
 * The files that run alone at the end, after every other file (globs relative
 * to `cwd`). Not "the heavy tier": only whoever races for a real OS resource
 * with TIMING assertions, which under the CPU contention of N workers slips
 * past its deadline: `ai-bridge-singleton` spawns 5 daemons fighting over a
 * socket and checks that exactly ONE is left listening within 15 s (measured
 * timeout at 15221 ms under 4 shards). Whoever turns flaky under parallelism
 * is added here; the rest of the code does not change.
 */
export const SERIAL_GLOBS = [
  "server/ai-bridge-singleton.test.ts",
  "server/ai-bridge.test.ts",
  // Spawns a real wrapper process tree and asserts a 4500ms wall-clock kill
  // deadline: reproduced red under CPU contention three times in a row
  // (10/09/2026), green standalone every time.
  "server/providers/codex-complete.test.ts",
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

/**
 * The order the workers take files in: slowest first, so the long ones start
 * while there is still a short tail to fill the gaps behind them (LPT, but
 * dynamic: the queue is consumed as workers free up, so a wrong estimate costs
 * one file, not a whole shard). A file with no known duration weighs the median.
 */
export function orderByDuration(files: string[], durations: Record<string, number>): string[] {
  const known = files.map((f) => durations[f]).filter((d): d is number => typeof d === "number" && d > 0);
  const sortedKnown = [...known].sort((a, b) => a - b);
  const median = sortedKnown.length ? sortedKnown[Math.floor(sortedKnown.length / 2)] : 1;
  return files
    .map((file) => ({ file, seconds: durations[file] ?? median }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))
    .map((x) => x.file);
}

/** Deterministic shuffle (mulberry32 + Fisher-Yates): the same seed gives the same order. */
export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Green (0) only if EVERY file is green; otherwise the first non-zero code. */
export function aggregateVerdict(exitCodes: number[]): number {
  const failed = exitCodes.find((c) => c !== 0);
  return failed ?? 0;
}

/** The test names bun prints on a red file: `(fail) describe > name [12.00ms]`. */
export function redTestNames(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!);
}

/**
 * The environment every file is born with, before its own scratch directory.
 *
 * The home and the OpenClaw config are taken out of the inherited environment
 * so the preload derives them INSIDE the file's `TMPDIR` (it only does so when
 * none is chosen), and `DATA_DIR` goes for the same reason: a runner started
 * from the owner's terminal must not hand its live state folder to a test.
 */
export function fileEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = gitIsolationEnv({ ...base });
  for (const key of ["DATA_DIR", "TOPICS_DATA_DIR", "TOPICS_HOME", "OPENCLAW_CONFIG_PATH"]) delete env[key];
  return env;
}

/** A file stuck for this long is killed by its own preload (exit 124); the slowest file takes ~25 s. */
const FILE_CAP_MS = 5 * 60_000;

interface FileResult {
  file: string;
  code: number;
  wallS: number;
  /** CPU the process (and the children it waited for) used: how much of the wall was work and not waiting. */
  cpuS: number;
  /** stdout + stderr, kept only when the file is red. */
  output: string;
}

/**
 * Runs ONE file in its own `bun test` process, in its own scratch directory.
 *
 * THE OUTPUT GOES TO A FILE, NOT TO A PIPE THIS PROCESS READS. A test leaves
 * children behind (a daemon, a `sleep 600` standing in for a CLI, a frozen
 * tree) and they inherit the pipe: reading it to the end then waits for the
 * last of them, and a runner that waits for a stray never reports. A file has
 * no end to wait for. Only a red file is read back.
 */
async function runFile(file: string, scratch: string, outBase: string, env: Record<string, string | undefined>, timeoutMs: string): Promise<FileResult> {
  // `TMPDIR` is the file's own scratch directory: every `os.tmpdir()` of the
  // file lands there, and nowhere a neighbour can see it.
  mkdirSync(scratch, { recursive: true });
  const t0 = Date.now();
  const proc = Bun.spawn(["bun", "test", "--timeout", timeoutMs, file], {
    cwd: REPO_ROOT,
    env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, [PRIVATE_SCRATCH_ENV]: "1", TOPICS_GATE_MAX_RUN_MS: String(FILE_CAP_MS) },
    stdout: Bun.file(`${outBase}.out`),
    stderr: Bun.file(`${outBase}.err`),
  });
  const code = await proc.exited;
  const wallS = (Date.now() - t0) / 1000;
  const read = (path: string): string => {
    try { return code === 0 ? "" : readFileSync(path, "utf8"); } catch { return ""; } finally { rmSync(path, { force: true }); }
  };
  const err = read(`${outBase}.err`);
  const out = read(`${outBase}.out`);
  rmSync(scratch, { recursive: true, force: true });
  const cpuS = Number(proc.resourceUsage()?.cpuTime.total ?? 0n) / 1e6;
  return { file, code, wallS, cpuS, output: `${err}${out}` };
}

/** Runs `fn` over `items` with `n` workers pulling from one shared queue, in order. */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** `--shuffle` or `--shuffle=<seed>`: the seed, or null when the run is not shuffled. */
export function shuffleSeedOf(argv: readonly string[]): number | null {
  const flag = argv.find((a) => a === "--shuffle" || a.startsWith("--shuffle="));
  if (!flag) return null;
  const given = Number(flag.split("=")[1]);
  return Number.isInteger(given) && given >= 0 ? given : randomBytes(4).readUInt32BE(0);
}

/** The short base `testTmpDir` uses on purpose (a unix socket path must stay under 104 characters on macOS). */
const TEST_TMP_BASE = "/tmp/topics-test";
const TEST_TMP_BASE_NAME = "topics-test";

/**
 * Where a test can leave something in spite of the private `TMPDIR` of its
 * file: the real temp folder (a hard-coded path) and the base of `testTmpDir`,
 * which is a fixed path and not `os.tmpdir()`.
 */
const OUTER_TEMP_ROOTS: readonly string[] = [tmpdir(), TEST_TMP_BASE];

/** The names directly under `dir`, or none when it cannot be read. */
export function snapshotEntries(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

/** The names under `dir` now that were not in `before`, sorted. */
export function newEntries(before: ReadonlySet<string>, dir: string): string[] {
  return [...snapshotEntries(dir)].filter((name) => !before.has(name)).sort();
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const baseShards = Math.max(1, Number(process.env.TOPICS_UNIT_SHARDS) || defaultShards(cpus().length || 1));
  // Exactly the shell expansion used by test:unit. Preserve the raw override
  // too: an invalid value must reach Bun and fail, not silently become 30s.
  const timeoutMs = process.env.TOPICS_TEST_TIMEOUT_MS || "30000";
  const plan = planUnderLoad({
    load: loadavg()[0] ?? 0,
    cores: cpus().length || 1,
    shards: baseShards,
    timeoutMs: Number(timeoutMs),
    shardsExplicit: Number(process.env.TOPICS_UNIT_SHARDS) > 0,
  });
  if (plan.note) console.error(`test-unit-shards: ${plan.note}`);
  /**
   * ONE factor for the whole round, decided here and handed down.
   *
   * The tests that wait inside a window read it from the env (see
   * tests/helpers/time-slack.ts): measured here once, every file of this run
   * uses the SAME number instead of each one re-reading a load that moves
   * under it - including the load this very run is producing.
   */
  const load1 = loadavg()[0] ?? 0;
  const cores = cpus().length || 1;
  const slack = timeSlack({ load: load1, cores, forced: process.env[TIME_SLACK_ENV] });
  process.env[TIME_SLACK_ENV] = String(slack);
  if (slack > 1) console.error(`test-unit-shards: ${timeSlackNote(slack, load1, cores)}`);
  // Said BEFORE the first file starts, because whoever is timing this run from
  // outside has to hear it while there is still time on its cap to extend.
  if (plan.slowdown > 1) {
    const reason = `${plan.shards} shard invece di ${baseShards} sotto carico (pressione ${plan.pressure.toFixed(2)})`;
    console.error(gateSlowdownLine(plan.slowdown, reason));
  }
  // Every file inherits it, and so does every daemon a test starts: the check
  // at the end finds this run's leftovers by it (scripts/stray-ai-bridges.ts).
  const runId = newTestRunId();
  process.env[TEST_RUN_ENV] = runId;

  // Explicit arguments REPLACE the default roots, they do not add to them: a
  // `test:unit <one file>` that also ran the whole suite would be a trap for
  // whoever is narrowing down a single test. A leading `-` is a flag.
  const targets = argv.filter((a) => !a.startsWith("-"));
  const files = targets.length
    ? [...new Set(targets.flatMap((t) => (existsSync(resolve(REPO_ROOT, t)) && statSync(resolve(REPO_ROOT, t)).isDirectory() ? enumerateTestFiles([t.replace(/\/$/, "")], REPO_ROOT) : [t])))]
    : enumerateTestFiles(SUITE_ROOTS, REPO_ROOT);
  if (files.length === 0) {
    console.error("test-unit-shards: no test file found under", (targets.length ? targets : SUITE_ROOTS).join(", "));
    process.exit(2);
  }

  const { parallel, serial } = partitionTiers(files);
  const durations = loadDurations();
  const seed = shuffleSeedOf(argv);
  const order = seed === null ? orderByDuration(parallel, durations) : shuffleSeeded(parallel, seed);
  if (seed !== null) console.error(`test-unit-shards: shuffle seed ${seed} (repeat with --shuffle=${seed})`);
  // The plan without running it: the order the workers would take, then the
  // files that run alone at the end. One per line, so a test can read it and a
  // person can see what a seed does.
  if (argv.includes("--list")) {
    console.log([...order, ...serial].join("\n"));
    process.exit(0);
  }

  // One root for the whole run, one folder per file under it. It is made in the
  // real temp folder and removed at the end: what is left of it is a leak of
  // this runner and not of a test.
  const outerBefore = OUTER_TEMP_ROOTS.map(snapshotEntries);
  const runRoot = mkdtempSync(join(tmpdir(), "tu-"));
  mkdirSync(join(runRoot, "out"));
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Covers the children with the slot this process already holds: bun's
    // preload sees the marker and does NOT queue for a second slot.
    [GATE_HELD_ENV]: process.env[GATE_HELD_ENV] ?? "test-unit-shards",
  };
  const env = fileEnv(baseEnv);
  const results: FileResult[] = [];
  let seq = 0;
  let done = 0;
  const started = Date.now();
  const runOne = async (file: string): Promise<void> => {
    const n = seq++;
    const r = await runFile(file, join(runRoot, String(n)), join(runRoot, "out", String(n)), env, timeoutMs);
    results.push(r);
    done += 1;
    if (done % 200 === 0) console.error(`test-unit-shards: ${done}/${files.length}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
  };

  // The ordinary files first, N at a time; then the OS racers one by one, so
  // they run without the contention of the others.
  const N = Math.min(plan.shards, Math.max(1, order.length));
  await pool(order, N, runOne);
  await pool(serial, 1, runOne);
  const totalWallS = (Date.now() - started) / 1000;
  rmSync(runRoot, { recursive: true, force: true });
  // What reached the REAL temp folder in spite of the private one: a test that
  // writes to a hard-coded path. Judged only where nobody else is writing to
  // it (CI); on a developer machine other programs add entries all the time.
  const escaped = process.env.CI
    ? OUTER_TEMP_ROOTS.flatMap((dir, i) =>
        newEntries(outerBefore[i]!, dir)
          // The short base `testTmpDir` makes on purpose: what is INSIDE it is judged by the second root.
          .filter((name) => !(dir === tmpdir() && name === TEST_TMP_BASE_NAME))
          .map((name) => join(dir, name)))
    : [];

  // Reprint the output of the red files: the bar must see WHICH tests failed.
  // The first MAX_REPRINT in full; the names of all of them below.
  const MAX_REPRINT = 20;
  const reds = results.filter((r) => r.code !== 0).sort((a, b) => a.file.localeCompare(b.file));
  for (const r of reds.slice(0, MAX_REPRINT)) {
    console.error(`\n───── ${r.file} FALLITO (exit ${r.code}, ${r.wallS.toFixed(1)}s) ─────`);
    console.error(r.output.trimEnd());
    console.error(`riproduci: bun test --timeout ${timeoutMs} ${r.file}`);
  }

  console.log("\n── test:unit (un processo per file) ──");
  const lagging = [...results].sort((a, b) => b.wallS - a.wallS).slice(0, 5);
  const cpuTotal = results.reduce((sum, r) => sum + r.cpuS, 0);
  console.log(`  ${results.length} file, ${N} shard, wall ${totalWallS.toFixed(1)}s, cpu ${cpuTotal.toFixed(0)}s su ${cores} core; i più lenti: ${lagging.map((r) => `${r.file} ${r.wallS.toFixed(1)}s`).join(", ")}`);

  // The red files BY NAME, last, and on STDERR: the board's check runner
  // concatenates stdout then stderr and keeps the tail, so the last lines of
  // stderr are the only lines an agent is sure to read.
  const MAX_NAMED = 40;
  if (reds.length) {
    console.error(`file rossi (${reds.length}):`);
    for (const r of reds.slice(0, MAX_NAMED)) {
      const names = redTestNames(r.output);
      console.error(`  ✗ ${r.file}${names.length ? ` › ${names.slice(0, 3).join(" | ")}` : ` (exit ${r.code}, nessun test rosso: hook scaduto, crash o timeout di processo)`}`);
    }
    if (reds.length > MAX_NAMED) console.error(`  … e altri ${reds.length - MAX_NAMED}`);
  }
  if (escaped.length) {
    console.error(`voci apparse nella cartella temporanea vera durante il giro (${escaped.length}): un test scrive fuori da TMPDIR`);
    for (const name of escaped.slice(0, MAX_NAMED)) console.error(`  ✗ ${name}`);
  }
  // Last on stderr for the same reason as the names above. A daemon the run
  // left alive turns a green run red.
  const strays = await strayAiBridges(runId);
  await reportAndEndStrays(strays);
  const verdict = aggregateVerdict([...results.map((r) => r.code), escaped.length > 0 ? 1 : 0, strays.length > 0 ? 1 : 0]);
  console.log(`  ${verdict === 0 ? "PASS" : "FAIL"}  ${files.length} file (${parallel.length} par / ${serial.length} ser) in ${N} shard  wall ${totalWallS.toFixed(1)}s` + (verdict === 0 ? "" : `  (exit ${verdict})`));

  // Rewrite the measured durations only on request (merged over the old ones: a
  // file this run never reached keeps its previous estimate instead of vanishing).
  if (argv.includes("--record")) {
    const merged: Record<string, number> = { ...durations };
    for (const r of results) merged[r.file] = Number(r.wallS.toFixed(3));
    try {
      writeFileSync(DURATIONS_PATH, JSON.stringify(sortKeys(merged), null, 0) + "\n");
      console.log(`  durate aggiornate: ${Object.keys(merged).length} file → ${DURATIONS_PATH}`);
    } catch {
      /* durations are not critical: the next run uses the median */
    }
  }
  process.exit(verdict);
}

/** Sorted keys: the durations json stays a clean diff between runs. */
function sortKeys(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
