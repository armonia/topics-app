/**
 * The serial unit run hands the slack factor down too.
 *
 * THE HOLE. Three runners start unit or e2e tests; two measured the load once
 * and wrote `TOPICS_TEST_TIME_SLACK` for the children, and the SERIAL one - the
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
 * @covers GATE-16
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIME_SLACK_ENV } from "../../shared/test-time-slack";

const RUNNER = join(import.meta.dir, "..", "..", "scripts", "test-unit-serial.ts");
const ROOT = join(import.meta.dir, "..", "..");

/**
 * A test file that reports the factor it received. It goes in a temp dir and is
 * passed as an explicit path: this measures the handover, not the suite.
 */
function probe(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "slack-probe-"));
  const file = join(dir, "probe.test.ts");
  writeFileSync(file, body);
  return file;
}

function runProbe(file: string, env: Record<string, string>): string {
  const r = Bun.spawnSync(["bun", "run", RUNNER, file], {
    cwd: ROOT,
    env: { ...process.env, TOPICS_GATE_SLOTS: "0", ...env },
  });
  return r.stdout.toString() + r.stderr.toString();
}

test("the serial runner exports the factor to the tests it starts", () => {
  const file = probe(
    'import { expect, test } from "bun:test";\n' +
      `test("p", () => { console.error("SEEN=" + process.env.${TIME_SLACK_ENV}); expect(1).toBe(1); });\n`,
  );
  const out = runProbe(file, { [TIME_SLACK_ENV]: "3" });
  rmSync(join(file, ".."), { recursive: true, force: true });
  expect(out).toContain("SEEN=3");
});

test("a value forced by hand wins over the measurement", () => {
  // Whoever forced it knows something the script does not: reproducing a red,
  // or pinning a number while comparing two runs.
  const file = probe(
    'import { expect, test } from "bun:test";\n' +
      'import { TIME_SLACK } from "' +
      join(ROOT, "tests", "helpers", "time-slack").replace(/\\/g, "/") +
      '";\n' +
      'test("p", () => { console.error("FACTOR=" + TIME_SLACK); expect(1).toBe(1); });\n',
  );
  const out = runProbe(file, { [TIME_SLACK_ENV]: "4" });
  rmSync(join(file, ".."), { recursive: true, force: true });
  expect(out).toContain("FACTOR=4");
});

test("an explicit path replaces the default paths instead of adding to them", () => {
  // The whole suite is ~17k tests: if the defaults were still in, this probe
  // would not come back in seconds and the count would not be 1.
  const file = probe(
    'import { expect, test } from "bun:test";\ntest("only me", () => { expect(1).toBe(1); });\n',
  );
  const out = runProbe(file, { [TIME_SLACK_ENV]: "1" });
  rmSync(join(file, ".."), { recursive: true, force: true });
  expect(out).toContain("1 pass");
  expect(out).not.toContain("0 fail\n 0 pass");
  // A number of files other than one would mean the defaults came along.
  expect(out).toMatch(/Ran 1 tests? across 1 files?/);
});
