/** @covers LAND-16 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { CheckRun } from "../../shared/board";
import { measureIntegration, type IntegrationMeasureDeps } from "./integration-measure";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** origin (bare) with main, and a clone with three card branches: two clean, one conflicting with the first. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "integ-measure-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  sh(root, "init", "--quiet", "--bare", "-b", "main", origin);
  sh(root, "clone", "--quiet", origin, work);
  writeFileSync(join(work, "a.ts"), "base\n");
  sh(work, "add", "."); sh(work, "commit", "--quiet", "-m", "base"); sh(work, "push", "--quiet", "origin", "HEAD:main");
  const branch = (name: string, file: string, text: string) => {
    sh(work, "switch", "--quiet", "-c", name, "origin/main");
    writeFileSync(join(work, file), text);
    sh(work, "add", "."); sh(work, "commit", "--quiet", "-m", name);
    return sh(work, "rev-parse", "HEAD");
  };
  const one = branch("one", "a.ts", "one\n");
  const two = branch("two", "b.ts", "two\n");
  const clash = branch("clash", "a.ts", "clash\n");
  sh(work, "switch", "--quiet", "main");
  return { work, one, two, clash };
}

function deps(runs: (sha: string) => CheckRun[], seen: string[] = []): IntegrationMeasureDeps {
  return {
    git: async (cwd, args, env) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", ...env } });
      return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    },
    awaitCi: async ({ sha }) => { seen.push(sha); return runs(sha); },
    closeDraft: async () => undefined,
    describeRed: (r, sha) => `rosso su ${sha.slice(0, 8)}: ${r.find((x) => !x.ok)?.name}`,
  };
}

const ok = (name: string): CheckRun => ({ name, cmd: `github-ci:${name}`, ok: true, code: 0, ms: 1, timedOut: false, tail: "" });
const ko = (name: string): CheckRun => ({ name, cmd: `github-ci:${name}`, ok: false, code: 1, ms: 1, timedOut: false, tail: "unit rosso" });
const CHECKS = [{ name: "unit", cmd: "github-ci:unit" }];

describe("measureIntegration", () => {
  test("clean branches are merged onto origin/main in one commit and measured once; a clash goes back", async () => {
    const r = repo();
    const seen: string[] = [];
    const out = await measureIntegration(r.work, [
      { taskId: "card-one", commit: r.one }, { taskId: "card-clash", commit: r.clash }, { taskId: "card-two", commit: r.two },
    ], CHECKS, deps(() => [ok("unit")], seen));
    expect(out.verdict).toBe("pass");
    expect(out.measured).toEqual(["card-one", "card-two"]);
    expect(out.conflicts.map((c) => c.taskId)).toEqual(["card-clash"]);
    expect(out.conflicts[0]!.why).toContain("a.ts");
    expect(seen).toHaveLength(1);
    // The measured commit contains both branches.
    expect(sh(r.work, "merge-base", "--is-ancestor", r.one, out.commit!)).toBe("");
    expect(sh(r.work, "merge-base", "--is-ancestor", r.two, out.commit!)).toBe("");
    // Nothing left behind: no worktree, no local integration branch.
    expect(sh(r.work, "worktree", "list").split("\n")).toHaveLength(1);
    expect(sh(r.work, "branch", "--list", "topics/integrazione-*")).toBe("");
  });

  test("the same base and branches give the same sha: a restart finds the same CI run", async () => {
    const r = repo();
    const a = await measureIntegration(r.work, [{ taskId: "x", commit: r.one }, { taskId: "y", commit: r.two }], CHECKS, deps(() => [ok("unit")]));
    await Bun.sleep(1100);
    const b = await measureIntegration(r.work, [{ taskId: "x", commit: r.one }, { taskId: "y", commit: r.two }], CHECKS, deps(() => [ok("unit")]));
    expect(a.commit).toBe(b.commit!);
  });

  test("a red row is a red with the log; a row with no verdict is unmeasured, never green", async () => {
    const r = repo();
    const red = await measureIntegration(r.work, [{ taskId: "x", commit: r.one }], CHECKS, deps(() => [ko("unit")]));
    expect(red.verdict).toBe("fail");
    expect(red.why).toContain("unit");
    const silent = await measureIntegration(r.work, [{ taskId: "x", commit: r.one }], CHECKS, deps(() => [{ ...ko("unit"), notMeasured: true }]));
    expect(silent.verdict).toBe("unmeasured");
  });
});
