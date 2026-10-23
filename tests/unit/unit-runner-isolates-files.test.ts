/**
 * What one test file does to the world stays in its own process, and a file that
 * litters the temp folder is red.
 *
 * WHY A CHILD RUNNER. The property is about the run, not about any single test:
 * file A leaves a fake `window`, a `DATA_DIR`, an env var and a `mock.module`,
 * and file B must see none of it. A test cannot watch that from inside its own
 * process, so the real runner is started on two fixture files.
 *
 * WHY THE CONTROL RUN. A green runner proves nothing unless the fixtures really
 * leak. The same two files in ONE `bun test` process are the control: they must
 * go red there, or the green below says nothing about the runner. That is the
 * mutation of this test: put the two files in one process and it fails.
 *
 * @covers GATE-13
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const RUNNER = join(ROOT, "scripts/test-unit-shards.ts");

let dir = "";
const file = (name: string): string => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unit-runner-isolates-"));
  writeFileSync(file("dep.ts"), 'export const who = () => "real";\n');
  writeFileSync(
    file("a-pollutes.test.ts"),
    `import { expect, mock, test } from "bun:test";
mock.module("./dep.ts", () => ({ who: () => "fake" }));
(globalThis as Record<string, unknown>).window = { localStorage: {} };
process.env.DATA_DIR = "/leaked/data";
process.env.LEAK_SENTINEL = "left by a";
test("a pollutes", async () => {
  expect((await import("./dep.ts")).who()).toBe("fake");
});
`,
  );
  writeFileSync(
    file("b-needs-a-clean-world.test.ts"),
    `import { expect, test } from "bun:test";
test("b sees a clean world", async () => {
  expect("window" in globalThis).toBe(false);
  expect(process.env.DATA_DIR).toBeUndefined();
  expect(process.env.LEAK_SENTINEL).toBeUndefined();
  expect((await import("./dep.ts")).who()).toBe("real");
});
`,
  );
  writeFileSync(
    file("c-litters-tmp.test.ts"),
    `import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
test("c creates a folder and never removes it", () => {
  mkdirSync(join(tmpdir(), "left-behind-by-c"));
});
`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The real runner over these files: `bun run scripts/test-unit-shards.ts …`, one shard, no slot. */
function runner(files: string[], ...flags: string[]): { code: number; output: string } {
  const env: Record<string, string | undefined> = { ...process.env, TOPICS_UNIT_SHARDS: "1", TOPICS_GATE_HELD: "unit-runner-isolates-files" };
  const run = Bun.spawnSync([process.execPath, "run", RUNNER, ...flags, ...files], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode ?? -1, output: `${run.stderr}${run.stdout}` };
}

describe("the unit runner gives every file its own process", () => {
  test("control: the same two files in ONE bun process do contaminate each other", () => {
    const shared = Bun.spawnSync([process.execPath, "test", file("a-pollutes.test.ts"), file("b-needs-a-clean-world.test.ts")], {
      cwd: ROOT, env: { ...process.env, TOPICS_GATE_HELD: "unit-runner-isolates-files" }, stdout: "pipe", stderr: "pipe",
    });
    expect(shared.exitCode, "the fixtures do not leak: the green below would prove nothing").not.toBe(0);
  }, 60_000);

  test.each([["a then b", ["a-pollutes.test.ts", "b-needs-a-clean-world.test.ts"]], ["b then a", ["b-needs-a-clean-world.test.ts", "a-pollutes.test.ts"]]])(
    "%s: what a leaves is not there for b, in either order",
    (_label, names) => {
      const run = runner(names.map(file));
      expect(run.code, run.output).toBe(0);
    },
    60_000,
  );

  test("a shuffled run says its seed and can be repeated with it", () => {
    const first = runner([file("a-pollutes.test.ts"), file("b-needs-a-clean-world.test.ts")], "--shuffle=7");
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("shuffle seed 7 (repeat with --shuffle=7)");
  }, 60_000);

  test("a file that leaves a folder in the temp dir is red, by name, and the folder is gone", () => {
    const before = readdirSync(tmpdir()).filter((n) => n === "left-behind-by-c");
    const run = runner([file("c-litters-tmp.test.ts")]);
    expect(run.code, run.output).not.toBe(0);
    expect(run.output).toContain("c-litters-tmp.test.ts");
    expect(run.output).toContain("left-behind-by-c");
    // It went into the file's own scratch dir, which the runner removed: nothing reached this process's temp folder.
    expect(readdirSync(tmpdir()).filter((n) => n === "left-behind-by-c")).toEqual(before);
    expect(existsSync(join(tmpdir(), "left-behind-by-c"))).toBe(false);
  }, 60_000);
});
