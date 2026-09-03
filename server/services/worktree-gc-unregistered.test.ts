/**
 * THE FOLDER GIT NO LONGER REGISTERS, on real git.
 *
 * `~/.topics/worktrees/topics-app/sage-well/.git` was a `gitdir:` file
 * pointing at a missing `.git/worktrees/sage-well`: `git status` there exits
 * 128 "not a git repository", forever. The dirt probe answered `ok: false`,
 * the sweep read "dirty", and the residue added "detached HEAD". Result: 137
 * MB kept for a card closed and already on main, with a false diagnosis in
 * the thread sending the human to look for work that is not there. Every
 * half-failed `worktree remove` leaves the same shape.
 *
 * Verified here: that folder has a state of its OWN and is collectable:
 *  - the probe says `unregistered`, not just any `ok: false`;
 *  - the residue states the real fact, never "detached HEAD";
 *  - the decision: work on main, reap; live unmerged branch, free-checkout
 *    (the commits live on the branch, the folder is not a checkout);
 *  - the note on the card is honest and written once.
 *
 * @covers WORKTREE-13
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sweepWorktrees, decideWorktreeReap, type GcWorktree, type TaskStatus, type WorktreeGcDeps } from "./worktree-gc";
import { commitWorktreeResidue } from "./worktree-residue";
import { worktreeDirtProbe } from "./task-automerge";
import { branchStatusFromRepo } from "./branch-status";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}
const branchResolves = (repo: string, b: string) =>
  git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`).code === 0;

describe("la decisione pura con `unregistered`", () => {
  const base = {
    taskStatus: "done" as TaskStatus, taskArchived: false, hasRealDirt: true, unregistered: true,
    mergedIntoMain: false, autoMergeEnabled: true, mode: "branch" as const, canCommitResidue: true,
  };

  test("lavoro su main → reap, anche se la sonda era muta", () => {
    const d = decideWorktreeReap({ ...base, mergedIntoMain: true });
    expect(d.action).toBe("reap");
    expect(d.reason).toContain("registrata");
  });

  test("ramo vivo non mergiato → free-checkout, non commit-residue: non c'e' un indice su cui committare", () => {
    expect(decideWorktreeReap(base).action).toBe("free-checkout");
  });

  test("ramo sparito → keep, e la ragione non parla di modifiche non committate", () => {
    const d = decideWorktreeReap({ ...base, branchGone: true });
    expect(d.action).toBe("keep");
    expect(d.reason).not.toContain("non committate");
  });

  test("un task ATTIVO non si tocca nemmeno qui", () => {
    expect(decideWorktreeReap({ ...base, taskStatus: "review", mergedIntoMain: true }).action).toBe("keep");
  });
});

describe("la cartella non registrata, su git vero", () => {
  let repo: string, root: string;
  let trees: Map<string, GcWorktree>;
  let statuses: Map<string, TaskStatus | null>;
  let logs: string[];
  let notes: Array<{ taskId: string; message: string }>;

  function mountWorktree(id: string): GcWorktree {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-q", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "lavoro consegnato\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-q", "-m", `lavoro di ${id}`).code).toBe(0);
    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    return wt;
  }

  /** The production fault: git loses the registration, the folder stays. */
  function loseRegistration(id: string): void {
    rmSync(join(repo, ".git", "worktrees", id), { recursive: true, force: true });
    expect(git(trees.get(id)!.absPath, "status", "--porcelain").code).not.toBe(0);
  }

  /** Like the manager after the fix: git refuses, we remove the folder ourselves. */
  function removeFolder(wt: GcWorktree): void {
    if (git(repo, "worktree", "remove", "--force", wt.absPath).code !== 0) {
      git(repo, "worktree", "prune");
      rmSync(wt.absPath, { recursive: true, force: true });
    }
  }

  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (id) => {
        const st = statuses.get(id);
        return st === null ? { taskId: null } : { taskId: `task-${id}`, status: st ?? "done", archived: false };
      },
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeDirtProbe(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      tryLand: async () => "skipped",
      commitResidue: async (wt) => (await commitWorktreeResidue(wt.absPath)).ok,
      freeCheckout: async (id) => { removeFolder(trees.get(id)!); trees.delete(id); return true; },
      reap: async (id) => {
        const wt = trees.get(id)!;
        removeFolder(wt);
        git(repo, "branch", "-D", wt.branchName!);
        trees.delete(id);
        return true;
      },
      noteOnTask: (taskId, message) => { notes.push({ taskId, message }); },
      log: (m) => logs.push(m),
      ...over,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-unreg-"));
    repo = join(root, "repo");
    git(root, "init", "--quiet", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    trees = new Map(); statuses = new Map(); logs = []; notes = [];
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  test("la sonda distingue «registrazione persa» da un `git status` che non risponde", async () => {
    const wt = mountWorktree("sonda");
    expect(await worktreeDirtProbe(wt.absPath)).toEqual({ ok: true, paths: [] });
    loseRegistration("sonda");
    const probe = await worktreeDirtProbe(wt.absPath);
    expect(probe.ok).toBe(false);
    expect(probe.unregistered).toBe(true);
  });

  test("il residuo dice il fatto vero, mai «HEAD staccata»", async () => {
    const wt = mountWorktree("residuo");
    writeFileSync(join(wt.absPath, "residuo.txt"), "modifica mai committata\n");
    loseRegistration("residuo");
    const res = await commitWorktreeResidue(wt.absPath);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("registrata");
    expect(res.reason).not.toContain("staccata");
  });

  test("task chiuso, lavoro gia' su main → la cartella se ne va, e la card lo legge UNA volta, onestamente", async () => {
    const wt = mountWorktree("sage-well");
    expect(git(repo, "merge", "-q", "--ff-only", wt.branchName!).code).toBe(0);
    loseRegistration("sage-well");
    statuses.set("sage-well", "done");

    const s = await sweepWorktrees(deps());

    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.reaped).toBe(1);
    expect(s.kept).toBe(0);
    // The note: one, naming the lost registration and the work on main. Not
    // "may hold uncommitted work": that was the false diagnosis.
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain("non più registrata");
    expect(notes[0].message).toContain("su main");
    expect(notes.some((n) => /non committat/.test(n.message))).toBe(false);
  });

  test("task chiuso, ramo vivo NON mergiato → checkout liberato, ramo e commit intatti", async () => {
    const wt = mountWorktree("vivo");
    loseRegistration("vivo");
    statuses.set("vivo", "done");

    const s = await sweepWorktrees(deps());

    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.freed).toBe(1);
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
    expect(git(repo, "show", `${wt.branchName}:vivo.txt`).out).toBe("lavoro consegnato");
    expect(notes.some((n) => /non committat/.test(n.message))).toBe(false);
  });

  test("un `git status` muto per un'ALTRA ragione resta sporco: la cartella si tiene", async () => {
    // The same folder, but with the probe failing on an index.lock: the case
    // `ok: false` exists for, and it must not have been weakened.
    const wt = mountWorktree("lock");
    statuses.set("lock", "done");
    const s = await sweepWorktrees(deps({
      realDirt: async () => ({ ok: false, paths: [] }),
    }));
    expect(existsSync(wt.absPath)).toBe(true);
    expect(s.kept).toBe(1);
    expect(Object.keys(s.keptReasons).join()).toContain("non committate");
  });
});
