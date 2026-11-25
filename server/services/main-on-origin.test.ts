/** Main on origin, fast-forward only.  @covers LAND-14 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mainPushGit, pushMainToOrigin, sweepUnpushedMains } from "./main-on-origin";
import type { GitRunner } from "./own-commits";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mop-"));
  const origin = join(root, "origin.git"); const work = join(root, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv() });
  spawnSync("git", ["clone", "-q", origin, work], { env: gitEnv() });
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(work, "config", k, v);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a"), "1"); git(work, "add", "a"); git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "main");
  return { root, origin, work };
}
const commit = (cwd: string, f: string) => { writeFileSync(join(cwd, f), f); git(cwd, "add", f); git(cwd, "commit", "-qm", f); };

describe("main su origin, solo fast-forward", () => {
  test("land locale avanti → push", async () => {
    const { root, origin, work } = setup();
    try {
      commit(work, "b"); commit(work, "c");
      const r = await pushMainToOrigin(work);
      expect(r).toEqual({ ok: true, pushed: 2 });
      expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "main"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("storie divergenti → niente push, mai forzato", async () => {
    const { root, origin, work } = setup();
    try {
      const other = join(root, "other");
      spawnSync("git", ["clone", "-q", origin, other], { env: gitEnv() });
      for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(other, "config", k, v);
      commit(other, "x"); git(other, "push", "-q", "origin", "main");
      const before = git(origin, "rev-parse", "main");
      commit(work, "y");
      const r = await pushMainToOrigin(work);
      expect(r.ok).toBe(false);
      expect(git(origin, "rev-parse", "main")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("la spazzata riporta su origin e lo segnala", async () => {
    const { root, origin, work } = setup();
    try {
      commit(work, "z");
      const seen: Array<[string, number]> = [];
      await sweepUnpushedMains([work], (repo, n) => seen.push([repo, n]));
      expect(seen).toEqual([[work, 1]]);
      expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "main"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // 25/11: eleven worktrees of one repo pushed the same main every sweep.
  const counting = () => {
    const pushes: string[] = [];
    const run: GitRunner = (cwd, args) => { if (args[0] === "push") pushes.push(cwd); return mainPushGit(cwd, args); };
    return { pushes, run };
  };

  test("worktree dello stesso repo: main si spinge una volta, e lo sanno tutte", async () => {
    const { root, origin, work } = setup();
    try {
      const sibling = join(root, "sibling");
      git(work, "worktree", "add", "-q", "-b", "feature", sibling);
      commit(work, "w");
      const { pushes, run } = counting();
      const seen: Array<[string, number]> = [];
      const out = await sweepUnpushedMains([work, sibling], (repo, n) => seen.push([repo, n]), run);
      expect(pushes).toEqual([work]);
      expect(seen).toEqual([[work, 1], [sibling, 0]]);
      expect(out).toEqual([{ repo: work, result: { ok: true, pushed: 1 } }]);
      expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "main"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("un push rifiutato (hook di pre-push): un tentativo per repo, nessuna worktree avvisata", async () => {
    const { root, origin, work } = setup();
    try {
      const sibling = join(root, "sibling");
      git(work, "worktree", "add", "-q", "-b", "feature", sibling);
      const before = git(origin, "rev-parse", "main");
      commit(work, "h");
      // The test env switches git hooks off (GIT_CONFIG_*), so the refusal is the runner's.
      const pushes: string[] = [];
      const run: GitRunner = async (cwd, args) => {
        if (args[0] !== "push") return mainPushGit(cwd, args);
        pushes.push(cwd);
        return { code: 1, stdout: "", stderr: "STOP: push su main bloccato\nerror: failed to push some refs" };
      };
      const seen: string[] = [];
      const out = await sweepUnpushedMains([work, sibling], (repo) => seen.push(repo), run);
      expect(pushes).toEqual([work]);
      expect(seen).toEqual([]);
      expect(out).toHaveLength(1);
      expect(out[0].result).toMatchObject({ ok: false, reason: expect.stringContaining("STOP") });
      expect(git(origin, "rev-parse", "main")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
