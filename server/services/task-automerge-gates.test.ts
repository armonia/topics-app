/**
 * Fast static gates the land runs on a realign merge (verdicts: red, unmeasured, green).
 * @covers LAND-13
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runStaticGates } from "./task-automerge-gates";

const dirs: string[] = [];
function tree(scripts: Record<string, string>, withModules: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "static-gates-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  if (withModules) mkdirSync(join(dir, "node_modules"));
  return dir;
}
const ALL = { "lint:design-system": "x", "check:deadcode-prod": "x", "gates:fast": "x" };
const ok = { code: 0, stdout: "", stderr: "" };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("runStaticGates", () => {
  test("no node_modules and the install does not provide them: unmeasured, nothing runs", async () => {
    const ran: string[] = [];
    const verdict = await runStaticGates(tree(ALL, false), async (_c, a) => { ran.push(a[0]); return ok; }, async () => undefined);
    expect(verdict?.kind).toBe("unmeasured");
    expect(ran).toEqual([]);
  });

  test("the install provides the dependencies: the gates run", async () => {
    const dir = tree(ALL, false);
    const ran: string[] = [];
    const verdict = await runStaticGates(dir, async (_c, a) => { ran.push(a[0]); return ok; }, async (cwd) => { mkdirSync(join(cwd, "node_modules")); });
    expect(verdict).toBeNull();
    expect(ran).toHaveLength(3);
  });

  test("an install that hit its deadline: unmeasured, the reason names the install", async () => {
    const ran: string[] = [];
    const verdict = await runStaticGates(tree(ALL, false), async (_c, a) => { ran.push(a[0]); return ok; }, async () => ({ timedOut: true }));
    expect(verdict).toMatchObject({ kind: "unmeasured", detail: expect.stringContaining("installazione") });
    expect(ran).toEqual([]);
  });

  test("a project without those scripts lands as before, with no install", async () => {
    let installed = false;
    const verdict = await runStaticGates(tree({ build: "x" }, false), async () => ok, async () => { installed = true; });
    expect(verdict).toBeNull();
    expect(installed).toBe(false);
  });

  test("a non-zero exit is a red naming the command, the exit and the last line", async () => {
    const verdict = await runStaticGates(tree(ALL, true), async () => ({ code: 1, stdout: "a\nraw-control 15\n", stderr: "" }));
    expect(verdict).toEqual({ kind: "red", detail: "bun run lint:design-system (exit 1): raw-control 15" });
  });

  test("gates run in order and stop at the first red", async () => {
    const ran: string[] = [];
    const verdict = await runStaticGates(tree(ALL, true), async (_c, a) => {
      ran.push(a[0]);
      return a[0] === "check:deadcode-prod" ? { code: 1, stdout: "dead", stderr: "" } : ok;
    });
    expect(ran).toEqual(["lint:design-system", "check:deadcode-prod"]);
    expect(verdict?.kind).toBe("red");
  });

  test("a timeout (exit 124) and an unknown command are unmeasured, not red", async () => {
    const slow = await runStaticGates(tree(ALL, true), async () => ({ code: 124, stdout: "", stderr: "" }));
    expect(slow?.kind).toBe("unmeasured");
    const unknown = await runStaticGates(tree(ALL, true), async () => ({ code: 2, stdout: "", stderr: "error: unknown command check-design-system" }));
    expect(unknown?.kind).toBe("unmeasured");
  });
});
