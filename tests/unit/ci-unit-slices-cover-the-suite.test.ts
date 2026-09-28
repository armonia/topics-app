/**
 * The `unit` jobs of ci.yml run the WHOLE suite, split or not.
 *
 * WHY THIS TEST EXISTS. Pull requests run the unit suite as parallel jobs, one
 * per slice of suite roots, each slice through the serial runner. The roots are
 * written in the workflow, and the list they have to add up to lives in
 * `SUITE_ROOTS` (scripts/test-unit-shards.ts), which the serial runner and the
 * sharded one both read. Two copies of one list drift: a root added to
 * `SUITE_ROOTS` and not to the matrix would be a folder no pull request ever
 * tests, with every job green. So both lists the matrix can take (the pull
 * request one and the push one) are read here and compared with it.
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
const axis = unit.match(/^ {8}roots: \$\{\{ fromJSON\(github\.event_name == 'push' && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}$/m);

/** One slice per entry, each entry the roots it runs, without the `./`. */
function slicesOf(literal: string): string[][] {
  return (JSON.parse(literal) as string[]).map((entry) => entry.trim().split(/\s+/).map((r) => r.replace(/^\.\//, "")));
}

describe("the unit jobs of ci.yml cover every suite root", () => {
  test("the matrix has the two lists this test reads, and the suite has roots", () => {
    // Without these the checks below would compare nothing with nothing.
    expect(axis).not.toBeNull();
    expect(SUITE_ROOTS.length).toBeGreaterThan(0);
  });

  test("a push to main runs ONE slice with every root: the full serial run", () => {
    const push = slicesOf(axis![1]!);
    expect(push).toHaveLength(1);
    expect([...push[0]!].sort()).toEqual([...SUITE_ROOTS].sort());
  });

  test("a pull request runs every root exactly once, in more than one slice", () => {
    const pr = slicesOf(axis![2]!);
    expect(pr.length).toBeGreaterThan(1);
    const roots = pr.flat();
    expect(new Set(roots).size).toBe(roots.length);
    expect([...roots].sort()).toEqual([...SUITE_ROOTS].sort());
  });

  test("each slice goes through the serial runner, with its roots and nothing else", () => {
    expect(unit).toContain("UNIT_ROOTS: ${{ matrix.roots }}");
    expect(unit).toContain('bun run scripts/slot.ts test:unit -- "bun run scripts/test-unit-serial.ts $UNIT_ROOTS"');
  });
});
