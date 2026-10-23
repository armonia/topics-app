/**
 * The unit runner hands the slack factor down to the files it starts.
 *
 * THE HOLE. Three runners start unit or e2e tests; two measured the load once
 * and wrote `TOPICS_TEST_TIME_SLACK` for the children, and the UNIT one - the
 * one `bun run test:unit` starts, which the local bar and CI use - wrote
 * nothing. So each test file computed the factor by itself at import time, on a
 * run that lasts half an hour: a file loaded at second zero sees a quiet box, a
 * file loaded twenty minutes in sees the load the run itself is making. Same
 * suite, two different ideas of how slow the machine is.
 *
 * Measured on 20/09: a full bar at load 26 went red on exactly two tests out of
 * 16,991, both of them waiting inside a time window, both green alone and green
 * as a pair immediately after.
 *
 * WHAT IS PINNED HERE, and why it is the wiring rather than the arithmetic (the
 * numbers are already covered by `shared/test-time-slack.test.ts`):
 *  - the runner EXPORTS the variable, because a child that does not see it
 *    falls back to measuring a load that moves under it;
 *  - an explicit value SURVIVES: forcing it by hand must keep winning;
 *  - explicit paths REPLACE the defaults, or narrowing down to one file would
 *    quietly run the whole suite - which is exactly what this script did on its
 *    first draft, for ten minutes, before this test existed.
 *
 * HOW IT IS READ. The runner prints a file's output ONLY when the file is red,
 * so a probe cannot report what it saw by printing: it ASSERTS inside, and the
 * test out here reads the runner's exit code (0 means the probe saw the value).
 * The fourth test pins the other direction: a wrong expectation comes back red,
 * which proves the probe bites instead of passing vacuously.
 *
 * @covers GATE-16
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIME_SLACK_ENV } from "../../shared/test-time-slack";

const RUNNER = join(import.meta.dir, "..", "..", "scripts", "test-unit-shards.ts");
const ROOT = join(import.meta.dir, "..", "..");

/**
 * A test file that asserts the factor it received. It goes in a temp dir and
 * is passed as an explicit path: this measures the handover, not the suite.
 * The caller removes the directory: a probe that stays behind is a leak of
 * this file, and the runner marks a file that leaks its scratch red.
 */
function probe(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "slack-probe-"));
  const file = join(dir, "probe.test.ts");
  writeFileSync(file, body);
  return file;
}

function runProbe(file: string, env: Record<string, string>): { code: number; out: string } {
  const t0 = Date.now();
  const r = Bun.spawnSync(["bun", "run", RUNNER, file], {
    cwd: ROOT,
    env: { ...process.env, TOPICS_GATE_SLOTS: "0", TOPICS_UNIT_SHARDS: "1", ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() + ` [${Date.now() - t0}ms]` };
}

test("the unit runner exports the factor to the tests it starts", () => {
  const file = probe(
    'import { expect, test } from "bun:test";\n' +
      `test("p", () => { expect(process.env.${TIME_SLACK_ENV}).toBe("3"); });\n`,
  );
  try {
    expect(runProbe(file, { [TIME_SLACK_ENV]: "3" }).code).toBe(0);
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
});

test("a value forced by hand wins over the measurement", () => {
  // Whoever forced it knows something the script does not: reproducing a red,
  // or pinning a number while comparing two runs.
  const file = probe(
    'import { expect, test } from "bun:test";\n' +
      'import { TIME_SLACK } from "' +
      join(ROOT, "tests", "helpers", "time-slack").replace(/\\/g, "/") +
      '";\n' +
      'test("p", () => { expect(TIME_SLACK).toBe(4); });\n',
  );
  try {
    expect(runProbe(file, { [TIME_SLACK_ENV]: "4" }).code).toBe(0);
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
});

test("a wrong expectation comes back red, so the probes above bite", () => {
  // Without this, the two tests above would stay green even if the probe never
  // ran or never saw the variable: a probe that cannot go red proves nothing.
  const file = probe(
    'import { expect, test } from "bun:test";\n' +
      `test("p", () => { expect(process.env.${TIME_SLACK_ENV}).toBe("not-the-forced-value"); });\n`,
  );
  try {
    const { code, out } = runProbe(file, { [TIME_SLACK_ENV]: "1" });
    expect(code).not.toBe(0);
    expect(out).toContain("1 file, ");
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
});

test("an explicit path replaces the default paths instead of adding to them", () => {
  // The whole suite is hundreds of files: if the defaults were still in, this
  // probe would not come back in seconds and the summary would count more than
  // one file.
  const file = probe(
    'import { expect, test } from "bun:test";\ntest("only me", () => { expect(1).toBe(1); });\n',
  );
  try {
    const t0 = Date.now();
    const { code, out } = runProbe(file, { [TIME_SLACK_ENV]: "1" });
    const wallMs = Date.now() - t0;
    expect(code).toBe(0);
    // The runner's own summary always prints, even on a green run: one file,
    // one shard. A number of files other than one would mean the defaults came
    // along.
    expect(out).toContain("1 file, ");
    expect(wallMs).toBeLessThan(60_000);
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
});
