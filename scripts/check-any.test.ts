/**
 * A ratchet only ratchets while its list is true. Before this test the script
 * printed `missing: … (skipped)` on stderr and still exited 0, so renaming one
 * of the six tracked files left CI green over five of them while the summary
 * line kept claiming six. Here the stale list is seen RED.
 *
 * The script runs as a PROCESS, not as an import: what has to be proven is the
 * exit code that stops CI, and `main()` runs at import time and calls
 * `process.exit`.
  * @covers GATE-01 @covers GATE-02
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { testTmpDir } from "../tests/integration/helpers";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = resolve(import.meta.dir, "check-any.ts");
const ROOT = testTmpDir("check-any");

async function run(args: string[], script: string = SCRIPT): Promise<{ code: number; out: string }> {
  // cwd pinned to the repo root: the script resolves its list against cwd, and
  // `bun test` can be invoked from anywhere.
  const proc = Bun.spawn(["bun", "run", script, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

function fixture(name: string, body: string): string {
  const file = join(ROOT, name);
  writeFileSync(file, body, "utf-8");
  return file;
}

/**
 * A copy of the script with its hard-coded list swapped for `entries`.
 *
 * The default-list branch is the one CI runs and the only one that can point
 * at TRACKED_FILES, so a stale list has to be tested there, not through argv.
 * The replace is asserted: if someone reshapes the literal, this test says so
 * instead of silently exercising the real six files.
 */
function scriptWithList(entries: string[]): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const patched = src.replace(
    /const TRACKED_FILES = \[[\s\S]*?\n\];/,
    `const TRACKED_FILES = ${JSON.stringify(entries)};`,
  );
  if (patched === src) {
    throw new Error("TRACKED_FILES literal not found in check-any.ts. Update this test alongside it.");
  }
  const copy = join(ROOT, "check-any-copy.ts");
  writeFileSync(copy, patched, "utf-8");
  return copy;
}

describe("check-any", () => {
  test("a tracked file that no longer exists fails the gate, it is not skipped", async () => {
    const present = fixture("present.ts", "export const N: number = 1;\n");
    const gone = join(ROOT, "renamed-away.ts"); // deliberately never written
    const { code, out } = await run([], scriptWithList([present, gone]));

    expect(code).not.toBe(0);
    expect(out).toContain(gone);
    // The reader has to learn WHERE to fix it, and must not be told the run was clean.
    expect(out).toContain("TRACKED_FILES");
    expect(out).not.toContain("OK");
  });

  test("a path passed on the command line gets the same treatment", async () => {
    const gone = join(ROOT, "never-written.ts");
    const { code, out } = await run([gone]);

    expect(code).not.toBe(0);
    expect(out).toContain(gone);
    // The hint has to fit where the path CAME FROM. Sending someone to edit
    // TRACKED_FILES over a path they typed is a wrong instruction, and the
    // branch that gets this right was untested: deleting the ternary left the
    // whole file green.
    expect(out).toContain("came from the command line");
    expect(out).not.toContain("TRACKED_FILES");
  });

  test("an unterminated /* is a failure, not a silently truncated scan", async () => {
    // The stripper is not a lexer, so this is all it takes: the `/*` inside a
    // string used to end the scan, and everything after it — including the
    // `any` on the next line — left the ratchet with nothing said.
    const truncating = fixture(
      "truncating.ts",
      ['const marker = "/*";', "export function f(x: any) { return x; }", ""].join("\n"),
    );
    const { code, out } = await run([truncating]);

    expect(code).toBe(1);
    expect(out).toContain(truncating);
    // Named cause, and a line number to go to.
    expect(out).toContain("unterminated /*");
    expect(out).toContain("line 1");
    // And it must not read as a clean run of one file.
    expect(out).not.toContain("all clean");
  });

  test("a real block comment is still stripped, `any` inside it and all", async () => {
    // The guard above must not have turned every /* */ into a failure: the
    // allow-list in the header is the reason this script is usable at all.
    const commented = fixture(
      "commented.ts",
      ["/* takes any shape,", "   returns any shape */", "export const N: number = 1;", ""].join("\n"),
    );
    const { code, out } = await run([commented]);

    expect(code).toBe(0);
    expect(out).toContain("1 file(s) scanned");
  });

  test("the green line counts the files actually scanned", async () => {
    const a = fixture("a.ts", "export const A: number = 1;\n");
    const b = fixture("b.ts", "export const B: string = 'x';\n");
    const { code, out } = await run([a, b]);

    expect(code).toBe(0);
    expect(out).toContain("2 file(s) scanned");
  });

  test("a hand-written annotation is still a failure, with the line named", async () => {
    const dirty = fixture("dirty.ts", "export function f(x: any) { return x; }\n");
    const { code, out } = await run([dirty]);

    expect(code).toBe(1);
    expect(out).toContain(":1");
    expect(out).toContain("FAIL");
  });

  test("the real tracked list is green", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toContain("file(s) scanned");
  });
});
