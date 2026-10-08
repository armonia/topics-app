/**
 * @covers GATE-19
 *
 * `scripts/parallel.ts` replaces the `a && b && c` chains of `typecheck` and
 * `lint`. Three things to hold still, each one a way to lie: a red that does not
 * exit non-zero, a piece that does not run because another is red, and an "in
 * parallel" that is really in sequence.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runAll, verdictOf } from "./parallel";

const SCRIPT = join(import.meta.dir, "parallel.ts");

function run(args: string[]) {
  const p = Bun.spawnSync([process.execPath, "run", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("parallel: the verdict", () => {
  test("green only when every piece is green", () => {
    expect(verdictOf([{ code: 0 }, { code: 0 }])).toBe(0);
    expect(verdictOf([])).toBe(0);
  });

  test("the exit is the first red in the given order, like the chain", () => {
    expect(verdictOf([{ code: 0 }, { code: 5 }, { code: 7 }])).toBe(5);
  });
});

describe("parallel: on the real script", () => {
  test("a red between two greens: the last one runs, exit is the red's, and it is named", () => {
    const r = run(["echo first", "echo second-red; exit 3", "echo third"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("first");
    expect(r.out).toContain("third");
    expect(r.out).toContain("second-red");
    expect(r.out).toContain("(exit 3)");
  });

  test("two reds: exits with the first in order and lists both", () => {
    const r = run(["exit 5", "exit 7"]);
    expect(r.code).toBe(5);
    expect(r.out).toContain("(exit 5)");
    expect(r.out).toContain("(exit 7)");
  });

  test("reds sit at the end of the output (the board keeps the tail)", () => {
    const r = run(["echo RED-here; exit 1", "echo green-here"]);
    expect(r.out.indexOf("green-here")).toBeLessThan(r.out.indexOf("RED-here"));
  });

  test("no commands is a usage error, not an empty green", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--jobs", "0", "true"]).code).toBe(2);
  });
});

describe("parallel: they really run together", () => {
  test("two 1 s commands finish well under 2 s", async () => {
    const t0 = Date.now();
    const res = await runAll(["sleep 1", "sleep 1"], 2);
    const dt = Date.now() - t0;
    expect(res.map((r) => r.code)).toEqual([0, 0]);
    expect(dt).toBeLessThan(1800);
  });

  test("--jobs 1 queues them (the cap holds)", async () => {
    const t0 = Date.now();
    await runAll(["sleep 0.5", "sleep 0.5"], 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  });
});
