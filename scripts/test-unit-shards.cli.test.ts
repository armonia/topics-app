/**
 * The real CLI with a fake `bun` on PATH: verdict, per-file environment,
 * scratch-directory cleanup, the serial tail, `--list` and the shard cap,
 * without ever loading a product test file.
 *
 * The fake `bun` never runs a test: for every call it records its arguments,
 * its scratch directory and the environment it was born with, then exits as
 * told (0, 7, or leaving a file behind in its scratch directory). The runner is always given explicit
 * files, never the whole suite, so the file stays fast.
 *
 * @covers GATE-12
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const RUNNER = join(ROOT, "scripts/test-unit-shards.ts");

// Six invented files (the fake `bun` never loads them) plus one real serial
// path: the SERIAL_GLOBS are repo-relative, so only a real serial path lands
// in the serial tail.
const FAKE_FILES = ["a", "b", "c", "d", "e", "f"].map((n) => `cli-fixture/${n}.test.ts`);
const REAL_SERIAL = "server/ai-bridge.test.ts";
const ALL_FILES = [...FAKE_FILES, REAL_SERIAL];

interface FakeCall {
  args: string[];
  file: string;
  timeout: string | null;
  tmpdir: string | null;
  tmp: string | null;
  temp: string | null;
  dataDir: string | null;
  topicsDataDir: string | null;
  topicsHome: string | null;
  openclawConfig: string | null;
  ci: string | null;
  gateHeld: string | null;
  timeSlack: string | null;
  runId: string | null;
  gateMaxRunMs: string | null;
  tmpdirOwned: string | null;
  stdoutIsFile: boolean;
  stdoutIsPipe: boolean;
  start: number;
  end: number;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  calls: FakeCall[];
}

function runRunner(options: {
  files?: string[];
  extraArgs?: string[];
  ci?: string;
  timeoutMs?: string;
  shards?: string;
  sleepMs?: number;
  redBasename?: string;
  leakBasename?: string;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "unit-shards-cli-"));
  const executable = join(dir, "bun");
  // This executable never loads a test file. It records what the real runner
  // sent it (arguments, scratch directory, environment, stdout shape) and
  // exits as told by the environment below.
  writeFileSync(
    executable,
    `#!${process.execPath}
import { fstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const timeoutAt = args.indexOf("--timeout");
const timeout = timeoutAt >= 0 ? args[timeoutAt + 1] : null;
const file = timeoutAt >= 0 ? args[timeoutAt + 2] : args[args.length - 1];
const start = Date.now();
const sleepMs = Number(process.env.TOPICS_SHARDS_CLI_SLEEP_MS ?? "0");
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
const red = process.env.TOPICS_SHARDS_CLI_RED ?? "";
const leak = process.env.TOPICS_SHARDS_CLI_LEAK ?? "";
const isRed = red !== "" && file.endsWith(red);
if (isRed) {
  console.log("FAKE_STDOUT_RED_EVIDENCE");
  console.error("FAKE_STDERR_RED_EVIDENCE");
}
const stat1 = fstatSync(1);
const record = {
  args, file, timeout,
  tmpdirOwned: process.env.TOPICS_TEST_PRIVATE_SCRATCH ?? null,
  tmpdir: process.env.TMPDIR ?? null, tmp: process.env.TMP ?? null, temp: process.env.TEMP ?? null,
  dataDir: process.env.DATA_DIR ?? null, topicsDataDir: process.env.TOPICS_DATA_DIR ?? null,
  topicsHome: process.env.TOPICS_HOME ?? null, openclawConfig: process.env.OPENCLAW_CONFIG_PATH ?? null,
  ci: process.env.CI ?? null, gateHeld: process.env.TOPICS_GATE_HELD ?? null,
  timeSlack: process.env.TOPICS_TEST_TIME_SLACK ?? null, runId: process.env.TOPICS_TEST_RUN_ID ?? null,
  gateMaxRunMs: process.env.TOPICS_GATE_MAX_RUN_MS ?? null,
  stdoutIsFile: stat1.isFile(), stdoutIsPipe: stat1.isFIFO() || stat1.isSocket(),
  start, end: Date.now(),
};
writeFileSync(join(process.env.TOPICS_SHARDS_CLI_FIXTURE, String(process.pid) + ".json"), JSON.stringify(record));
if (leak !== "" && file.endsWith(leak)) writeFileSync(join(process.env.TMPDIR, "leaked-" + process.pid + ".txt"), "leak");
if (isRed) process.exit(7);
`,
  );
  chmodSync(executable, 0o755);
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.CI;
  delete env.TOPICS_UNIT_SHARDS;
  delete env.TOPICS_TEST_TIMEOUT_MS;
  // Live state the parent holds on purpose: none of it may reach the child.
  env.DATA_DIR = "/tmp/should-not-reach-child";
  env.TOPICS_DATA_DIR = "/tmp/should-not-reach-child-topics";
  env.TOPICS_HOME = "/tmp/should-not-reach-child-home";
  env.OPENCLAW_CONFIG_PATH = "/tmp/should-not-reach-child-config.json";
  if (options.ci !== undefined) env.CI = options.ci;
  if (options.timeoutMs !== undefined) env.TOPICS_TEST_TIMEOUT_MS = options.timeoutMs;
  if (options.shards !== undefined) env.TOPICS_UNIT_SHARDS = options.shards;
  env.PATH = `${dir}${delimiter}${env.PATH ?? ""}`;
  env.TOPICS_GATE_HELD = "unit-shards-cli-fixture";
  env.TOPICS_TEST_TIME_SLACK = "1";
  env.TOPICS_SHARDS_CLI_FIXTURE = dir;
  env.TOPICS_SHARDS_CLI_SLEEP_MS = String(options.sleepMs ?? 0);
  if (options.redBasename !== undefined) env.TOPICS_SHARDS_CLI_RED = options.redBasename;
  if (options.leakBasename !== undefined) env.TOPICS_SHARDS_CLI_LEAK = options.leakBasename;
  try {
    // If this guard fails, NEVER fall through to a nested real suite.
    expect(Bun.which("bun", { PATH: env.PATH })).toBe(executable);
    const proc = Bun.spawnSync([process.execPath, "run", RUNNER, ...(options.files ?? []), ...(options.extraArgs ?? [])], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const calls: FakeCall[] = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FakeCall);
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
      calls,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The highest number of fake `bun` processes alive at the same time. */
function maxOverlap(calls: FakeCall[]): number {
  const points: Array<[number, number]> = [];
  for (const c of calls) {
    points.push([c.start, 1]);
    points.push([c.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let live = 0;
  let max = 0;
  for (const [, d] of points) {
    live += d;
    max = Math.max(max, live);
  }
  return max;
}

describe("unit shards CLI", () => {
  test("all green: one `bun test --timeout <ms> <file>` call per file, isolated environment", () => {
    const result = runRunner({ files: ALL_FILES, ci: "true", sleepMs: 60 });
    expect(result.code).toBe(0);
    expect(result.calls.length).toBe(ALL_FILES.length);
    // Every file shows up in exactly one call, and every call carries exactly
    // one file: the runner never batches files into a shared process.
    expect(result.calls.map((c) => c.file).sort()).toEqual([...ALL_FILES].sort());
    const runIds = new Set<string>();
    const tmpDirs = new Set<string>();
    for (const call of result.calls) {
      expect(call.args).toEqual(["test", "--timeout", "30000", call.file]);
      expect(call.timeout).toBe("30000");
      // The slot marker and CI come through; the live state does not, even
      // though the parent holds it.
      expect(call.ci).toBe("true");
      expect(call.gateHeld).toBe("unit-shards-cli-fixture");
      expect(call.timeSlack).toBe("1");
      expect(call.dataDir).toBeNull();
      expect(call.topicsDataDir).toBeNull();
      expect(call.topicsHome).toBeNull();
      expect(call.openclawConfig).toBeNull();
      // One scratch directory per file, all under the same run root.
      expect(call.tmpdir).toBeTruthy();
      expect(call.tmp).toBe(call.tmpdir);
      expect(call.temp).toBe(call.tmpdir);
      // The preload must know the runner owns it, or it nests a second one.
      expect(call.tmpdirOwned).toBe("1");
      tmpDirs.add(call.tmpdir!);
      // The child writes to a capture file, not to a pipe the runner reads:
      // a test that leaves children behind would hand them the pipe and the
      // runner would wait for the last of them instead of reporting. Only a
      // red file is read back (proven by the red test below).
      expect(call.stdoutIsFile).toBe(true);
      expect(call.stdoutIsPipe).toBe(false);
      expect(call.runId).toBeTruthy();
      runIds.add(call.runId!);
      expect(call.gateMaxRunMs).toBeTruthy();
    }
    expect(tmpDirs.size).toBe(ALL_FILES.length);
    expect(new Set([...tmpDirs].map((d) => dirname(d))).size).toBe(1);
    // One run id for the whole round, so the stray check at the end can tell
    // this run's daemons from anybody else's.
    expect(runIds.size).toBe(1);
    // The serial file starts after every other file: the serial tail runs
    // alone at the end, without the contention of the rest.
    const serial = result.calls.find((c) => c.file === REAL_SERIAL)!;
    const rest = result.calls.filter((c) => c.file !== REAL_SERIAL);
    expect(serial.start).toBeGreaterThanOrEqual(Math.max(...rest.map((c) => c.end)));
  });

  test("TOPICS_TEST_TIMEOUT_MS passes through untouched, and an unset CI stays unset", () => {
    const result = runRunner({ files: ALL_FILES, timeoutMs: "17000" });
    expect(result.code).toBe(0);
    expect(result.calls.length).toBe(ALL_FILES.length);
    for (const call of result.calls) {
      expect(call.args).toEqual(["test", "--timeout", "17000", call.file]);
      expect(call.timeout).toBe("17000");
      expect(call.ci).toBeNull();
    }
  });

  test("a file that exits 7 turns the run red and is reprinted with its reproducer", () => {
    const red = FAKE_FILES[2]!;
    const result = runRunner({ files: ALL_FILES, redBasename: "c.test.ts" });
    expect(result.code).toBe(7);
    // stdout AND stderr of the red file land at the end of the report.
    expect(result.stderr).toContain("FAKE_STDOUT_RED_EVIDENCE");
    expect(result.stderr).toContain("FAKE_STDERR_RED_EVIDENCE");
    expect(result.stderr).toContain(red);
    expect(result.stderr).toContain(`riproduci: bun test --timeout 30000 ${red}`);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).not.toContain("PASS");
  });

  test("what a file leaves in its TMPDIR does not outlive it, and does not make the run red", () => {
    const result = runRunner({ files: ALL_FILES, leakBasename: "a.test.ts" });
    expect(result.code).toBe(0);
    // The scratch directories are removed whatever the file left in them.
    for (const call of result.calls) {
      expect(existsSync(call.tmpdir!), `scratch directory ${call.tmpdir} still exists`).toBe(false);
    }
  });

  test("--list prints the plan without launching any worker", () => {
    const first = runRunner({ files: ALL_FILES, extraArgs: ["--list"] });
    expect(first.code).toBe(0);
    expect(first.calls).toHaveLength(0);
    expect(first.stdout.trim().split("\n").sort()).toEqual([...ALL_FILES].sort());
    // The serial file runs last.
    expect(first.stdout.trim().split("\n").at(-1)).toBe(REAL_SERIAL);
  });

  test("--list --shuffle=5 is stable, and differs from the default order", () => {
    const one = runRunner({ files: ALL_FILES, extraArgs: ["--list", "--shuffle=5"] });
    const two = runRunner({ files: ALL_FILES, extraArgs: ["--list", "--shuffle=5"] });
    expect(one.code).toBe(0);
    expect(one.calls).toHaveLength(0);
    expect(two.calls).toHaveLength(0);
    expect(one.stdout).toBe(two.stdout);
    const plain = runRunner({ files: ALL_FILES, extraArgs: ["--list"] });
    expect(one.stdout).not.toBe(plain.stdout);
  });

  test("TOPICS_UNIT_SHARDS=2 never runs more than 2 workers at once", () => {
    const result = runRunner({ files: FAKE_FILES, shards: "2", sleepMs: 150 });
    expect(result.code).toBe(0);
    expect(result.calls.length).toBe(FAKE_FILES.length);
    expect(maxOverlap(result.calls)).toBe(2);
  });
});
