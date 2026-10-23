/**
 * The `unit` job of ci.yml runs the WHOLE suite, through the runner with a
 * process per file, and nothing narrows it.
 *
 * WHY THIS TEST EXISTS. The job used to be cut by suite root into slices, and
 * the roots written in the workflow had to add up to `SUITE_ROOTS`
 * (scripts/test-unit-shards.ts): a root added there and not to the matrix was a
 * folder no pull request ever tested, with every job green. The cut is gone, and
 * the same hole has a new shape: a path or a root pasted after the command would
 * quietly narrow what the job runs (explicit paths REPLACE the default roots),
 * and a `strategy.matrix` brought back would run the suite once per entry.
 * So the job is pinned to one command with no arguments and no matrix.
 *
 * A text scan and not a YAML parse, like the other tests that read ci.yml: the
 * repo has no YAML dependency, and the shape asserted is the one a person edits.
 *
 * @covers GATE-12
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUITE_ROOTS } from "../../scripts/test-unit-shards";

const CI = readFileSync(join(import.meta.dir, "../..", ".github/workflows/ci.yml"), "utf8");

/** The body of one job, from its `  name:` line to the next job. */
function jobBody(name: string): string {
  const from = CI.search(new RegExp(`^ {2}${name}:$`, "m"));
  if (from < 0) throw new Error(`job ${name} not found in ci.yml`);
  const rest = CI.slice(from + 1);
  const next = rest.search(/^ {2}[\w-]+:$/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const unit = jobBody("unit");

describe("the unit job of ci.yml covers the whole suite", () => {
  test("the suite has roots to cover", () => {
    // Without them the checks below would compare nothing with nothing.
    expect(SUITE_ROOTS.length).toBeGreaterThan(0);
  });

  test("it is one job, not a matrix of slices", () => {
    expect(unit).not.toMatch(/^ {4}strategy:/m);
    expect(unit).not.toContain("matrix.");
  });

  test("it runs the runner with no paths after it, so every suite root is run", () => {
    expect(unit).toContain('run: bun run scripts/slot.ts test:unit -- "bun run scripts/test-unit-shards.ts"');
  });

  test("the `check` job still reads its verdict", () => {
    expect(CI).toMatch(/UNIT_RESULT: \$\{\{ needs\.unit\.result \}\}/);
  });
});
