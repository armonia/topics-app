/**
 * @covers GATE-24
 *
 * The bar's gates enumerate files through git: a file not yet added is read by
 * none of them. `scripts/untracked-files.sh` makes that a red row of its own,
 * so `qa:gate` cannot say green over code no gate opened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../setup/bun-test-preload";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts/untracked-files.sh");
const BAR = readFileSync(join(ROOT, "scripts/qa-gate.sh"), "utf8");

let repo = "";
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = ""; });

function git(...args: string[]): void {
  // No user identity or hooks from whoever runs the suite.
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: gitEnv() });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
}

function freshRepo(): void {
  repo = mkdtempSync(join(tmpdir(), "untracked-files-"));
  git("init", "-q");
  writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "scratch/\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
}

function run(): { code: number; out: string } {
  const r = Bun.spawnSync(["bash", SCRIPT], { cwd: repo, env: gitEnv() });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() };
}

describe("untracked-files.sh", () => {
  test("a clean checkout is green", () => {
    freshRepo();
    expect(run()).toEqual({ code: 0, out: "nessun file nuovo fuori da git\n" });
  });

  test("a new file not added is red and named", () => {
    freshRepo();
    writeFileSync(join(repo, "egress-proxy.ts"), "export {};\n");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("egress-proxy.ts\n");
    expect(out).toContain("1 file nuovi fuori da git");
  });

  test("git add turns it green: what is staged is what the gates read", () => {
    freshRepo();
    writeFileSync(join(repo, "egress-proxy.ts"), "export {};\n");
    git("add", "egress-proxy.ts");
    expect(run().code).toBe(0);
  });

  test("ignored files do not count", () => {
    freshRepo();
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "notes.txt"), "x\n");
    expect(run().code).toBe(0);
  });
});

describe("qa-gate.sh wiring", () => {
  test("measured before the lanes start and reported in the summary", () => {
    const measured = BAR.indexOf("misura untracked-files ./scripts/untracked-files.sh");
    const lanes = BAR.indexOf('echo "== guard rail statici');
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(lanes);
    expect(BAR).toContain("\nriferisci untracked-files\n");
  });
});
