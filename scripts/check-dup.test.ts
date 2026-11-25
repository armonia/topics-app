/**
 * The gate is seen red on purpose: a throwaway tree with no clone passes against
 * its own baseline, then the same tree with a block copied into a second file
 * fails. The script runs as a process because what matters is the exit code.
 * @covers GATE-02
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "check-dup.ts");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A block of distinct, substantial lines; copied verbatim it becomes a clone. */
function block(salt: string): string {
  return Array.from({ length: 40 }, (_, i) => `export const ${salt}${i} = computeSomething(${i}, "${salt}-${i}", [${i}, ${i + 1}]);`).join("\n");
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dup-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "server"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "server", name), body);
  return dir;
}

function run(dir: string, baseline: string, ...args: string[]): { code: number; out: string } {
  const res = spawnSync("bun", ["run", SCRIPT, `--root=${dir}`, `--baseline=${baseline}`, ...args], { encoding: "utf-8" });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe("check:dup", () => {
  test("exits 0 on a tree without clones and 1 once a block is copied", () => {
    const clean = tree({ "a.ts": block("alpha"), "b.ts": block("beta") });
    const baseline = join(clean, "baseline.json");
    expect(run(clean, baseline, "--update-baseline").code).toBe(0);
    expect(run(clean, baseline).code).toBe(0);

    writeFileSync(join(clean, "server", "c.ts"), block("alpha"));
    const dirty = run(clean, baseline);
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("baseline allows");
  }, 60_000);

  test("exits 2 when the baseline is missing", () => {
    const dir = tree({ "a.ts": block("alpha") });
    expect(run(dir, join(dir, "missing.json")).code).toBe(2);
  }, 60_000);
});
