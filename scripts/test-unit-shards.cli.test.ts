/**
 * The real CLI with fake bun workers: tests the final verdict, environment,
 * output and complete inventory without nesting the product suite in itself.
 *
 * @covers GATE-12
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const RUNNER = join(ROOT, "scripts/test-unit-shards.ts");

interface WorkerCall {
  phase: number;
  attempt: number;
  ci: string | null;
  timeout: string;
  timeoutEnv: string | null;
  slot: string | null;
  files: string[];
}

function runFakeWorkers(options: { mode?: "serial-fails-once" | "parallel-fails"; ci?: string; timeout?: string; shards?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unit-shards-cli-"));
  const executable = join(dir, "bun");
  // This executable never loads a test file. It records the complete command
  // the real runner sent it and returns a controlled process/JUnit verdict.
  writeFileSync(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const args = process.argv.slice(2);
const files = args.filter(arg => /\\.(test|spec)\\.[cm]?[jt]sx?$/.test(arg));
const xml = args.find(arg => arg.startsWith("--reporter-outfile=")).slice("--reporter-outfile=".length);
const phase = files.includes("server/ai-bridge-singleton.test.ts") ? 2 : 1;
const dir = process.env.TOPICS_SHARDS_CLI_FIXTURE;
const counter = join(dir, "serial-attempts");
const attempt = phase === 2 ? (existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1) : 0;
if (phase === 2) writeFileSync(counter, String(attempt));
writeFileSync(join(dir, basename(xml) + ".json"), JSON.stringify({
  phase, attempt, ci: process.env.CI ?? null,
  timeout: args[args.indexOf("--timeout") + 1], timeoutEnv: process.env.TOPICS_TEST_TIMEOUT_MS ?? null,
  slot: process.env.TOPICS_GATE_HELD ?? null, files,
}));
const red = (process.env.TOPICS_SHARDS_CLI_MODE === "serial-fails-once" && phase === 2 && attempt === 1)
  || (process.env.TOPICS_SHARDS_CLI_MODE === "parallel-fails" && basename(xml) === "p1-shard-0.xml");
if (red) {
  console.log("FIRST_FAILURE_STDOUT_EVIDENCE");
  console.error("FIRST_FAILURE_STDERR_EVIDENCE");
  writeFileSync(xml, '<testsuites><testcase file="' + files[0] + '" classname="worker fixture" name="intentional failure"><failure /></testcase></testsuites>');
  process.exit(7);
}
writeFileSync(xml, "<testsuites />");
`);
  chmodSync(executable, 0o755);
  const env = { ...process.env };
  delete env.CI;
  delete env.TOPICS_UNIT_SHARDS;
  delete env.TOPICS_TEST_TIMEOUT_MS;
  if (options.ci !== undefined) env.CI = options.ci;
  if (options.timeout !== undefined) env.TOPICS_TEST_TIMEOUT_MS = options.timeout;
  if (options.shards !== undefined) env.TOPICS_UNIT_SHARDS = options.shards;
  env.PATH = `${dir}${delimiter}${env.PATH ?? ""}`;
  env.TOPICS_GATE_HELD = "unit-shards-cli-fixture";
  env.TOPICS_TEST_TIME_SLACK = "1";
  env.TOPICS_SHARDS_CLI_FIXTURE = dir;
  env.TOPICS_SHARDS_CLI_MODE = options.mode ?? "pass";
  try {
    // If this guard fails, NEVER fall through to a nested real suite.
    expect(Bun.which("bun", { PATH: env.PATH })).toBe(executable);
    const proc = Bun.spawnSync([process.execPath, "run", RUNNER], {
      cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const calls: WorkerCall[] = readdirSync(dir).filter(name => name.endsWith(".xml.json"))
      .sort().map(name => JSON.parse(readFileSync(join(dir, name), "utf8")) as WorkerCall);
    return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr), calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("unit shards CLI", () => {
  test("a serial failure stays red, is printed in full, and is never retried away", () => {
    const result = runFakeWorkers({ mode: "serial-fails-once", shards: "2" });
    expect(result.code).toBe(7);
    expect(result.calls.filter(call => call.phase === 2)).toHaveLength(1);
    expect(result.stderr).toContain("FIRST_FAILURE_STDOUT_EVIDENCE");
    expect(result.stderr).toContain("FIRST_FAILURE_STDERR_EVIDENCE");
    expect(result.stderr).toContain("worker fixture › intentional failure");
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).not.toContain("PASS");
  });

  test("a failed parallel worker stays red even when the serial tail succeeds", () => {
    const result = runFakeWorkers({ mode: "parallel-fails", shards: "2" });
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("FIRST_FAILURE_STDOUT_EVIDENCE");
    expect(result.calls.filter(call => call.phase === 2)).toHaveLength(1);
  });

  test.each([undefined, "true", "0"])("inherits CI=%s and preserves the explicit timeout in every worker", (ci) => {
    const result = runFakeWorkers({ ci, timeout: "17000", shards: "2" });
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(3);
    for (const call of result.calls) {
      expect(call.ci).toBe(ci ?? null);
      expect(call.timeout).toBe("17000");
      expect(call.timeoutEnv).toBe("17000");
      expect(call.slot).toBe("unit-shards-cli-fixture");
    }
  });

  test("defaults to at most two workers and schedules the serial suite inventory exactly once", () => {
    const result = runFakeWorkers();
    expect(result.code).toBe(0);
    const parallel = result.calls.filter(call => call.phase === 1);
    expect(parallel.length).toBeGreaterThanOrEqual(1);
    expect(parallel.length).toBeLessThanOrEqual(2);
    expect(result.calls.filter(call => call.phase === 2)).toHaveLength(1);
    expect(result.calls.every(call => call.timeout === "30000")).toBe(true);
    // Derive roots from the authoritative serial command and include Bun's
    // other accepted test names: a new .spec/.js must not silently disappear.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const roots = [...String(pkg.scripts["test:unit"]).matchAll(/\.\/([\w./-]+?)\/?(?=[\s'])/g)].map(match => match[1]);
    expect(roots.length).toBeGreaterThan(0);
    const expected = roots.flatMap(root => [...new Bun.Glob(`${root}/**/*`).scanSync({ cwd: ROOT, onlyFiles: true })])
      .filter(file => /[._](test|spec)\.[cm]?[jt]sx?$/.test(file)).sort();
    const actual = result.calls.flatMap(call => call.files).sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(result.calls.find(call => call.phase === 2)!.files).toEqual([
      "server/ai-bridge-singleton.test.ts", "server/ai-bridge.test.ts", "server/providers/codex-complete.test.ts",
    ]);
  });
});
