/**
 * @covers LAND-04
 *
 * The checkouts of this file live in `{worktree root}/_scratch/node-checks` (WORKTREE-STD-02), so the cut
 * release that must not block the land (LAND-19) and the boot sweep that must empty the folder (LAND-20)
 * are proved where the standard put them:
 *
 * @covers WORKTREE-STD-02+LAND-19
 * @covers WORKTREE-STD-02+LAND-20
 *
 * A node check checkout cut mid-release must not block the land (card 8e9c2873).
 *
 * @covers LAND-19
 *
 * The shutdown path: `stopReviewChecks` ends the round, the meter's `finally`
 * releases the checkout, and `process.exit` reaps the git it started. Here the
 * cut is simulated at every place it can land, on a real repository, and then
 * the same land a review approval runs is asked to merge the branch.
 *
 * @covers LAND-20
 *
 * What a process left when it died (whole checkouts, copies moved aside, folders
 * the macOS $TMPDIR cleaner emptied) is gone after the next boot sweep, from the
 * disk and from `git worktree list`; a checkout in use, or another server's, is not.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createNodeCheckWorktrees, nodeCheckRoot, openNodeCheckWorktree } from "./node-check-worktree";
import { createTaskAutoMerge } from "./task-automerge";
import type { DiscardGit } from "../lib/worktree-discard";
import { slackMs } from "../../tests/helpers/time-slack";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const BRANCH = "topics/node-delivery";
const WITH_REAL_GIT = slackMs(30_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { env: gitEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

const realGit: DiscardGit = async (cwd, args) => {
  try {
    git(cwd, ...args);
    return { code: 0 };
  } catch {
    return { code: 1 };
  }
};

/** A repo whose card branch is behind main, so the land has to realign it first. */
function repoWithNodeBranch(): { repo: string; checks: string } {
  const dir = mkdtempSync(join(tmpdir(), "node-check-wt-"));
  created.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  for (const name of ["LICENSE", "CHANGELOG.md", "README.md"]) writeFileSync(join(repo, name), `${name}\n`);
  for (const sub of ["landing", "tools", "server"]) {
    mkdirSync(join(repo, sub));
    for (let i = 0; i < 20; i++) writeFileSync(join(repo, sub, `f${i}.txt`), `${sub} ${i}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "root");
  git(repo, "switch", "-q", "-c", BRANCH);
  writeFileSync(join(repo, "server", "delivered.txt"), "node work\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "node delivery");
  git(repo, "switch", "-q", "main");
  writeFileSync(join(repo, "main-moved.txt"), "main moved on\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main moved");
  return { repo, checks: join(dir, "checks") };
}

/** Delete every other tracked file of `tree`: what a deletion killed half-way leaves. */
function deleteHalf(tree: string): void {
  const files = git(tree, "ls-files").split("\n").filter(Boolean);
  files.forEach((f, i) => { if (i % 2 === 0) unlinkSync(join(tree, f)); });
}

async function measureThenCut(repo: string, checks: string, cutGit: DiscardGit, cutDelete?: (p: string) => Promise<void>) {
  const lease = await openNodeCheckWorktree({
    git: cutGit, repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), root: checks, taskId: "8e9c2873-test",
    resolveHead: async (cwd) => git(cwd, "rev-parse", "HEAD").trim(),
    discard: cutDelete ? { deleteTree: cutDelete } : undefined,
  });
  expect(lease).not.toBeNull();
  // The pre-review checks ran here: the tree is whole and clean.
  expect(git(lease!.cwd, "status", "--porcelain").trim()).toBe("");
  await lease!.release();
}

async function land(repo: string) {
  const am = createTaskAutoMerge({ resolveTaskMerge: () => ({ repoPath: repo, branch: BRANCH, defaultBranch: "main" }) });
  return am.tryMerge("8e9c2873", "Node delivery");
}

describe("a node check checkout cut by a shutdown does not block the land", () => {
  test("cut while git deletes the tree in place", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const cut: DiscardGit = async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        // The reaped `git worktree remove --force`: half the tree gone, still registered.
        const tree = args[args.length - 1]!;
        if (existsSync(tree)) { deleteHalf(tree); return { code: 137 }; }
      }
      return realGit(cwd, args);
    };

    await measureThenCut(repo, checks, cut);

    expect(listed(repo)).toHaveLength(1);
    const res = await land(repo);
    expect(res.status).toBe("merged");
    expect(git(repo, "merge-base", "--is-ancestor", BRANCH, "main")).toBe("");
  }, WITH_REAL_GIT);

  test("cut while the moved-aside copy is deleted", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const killed = async (p: string) => { deleteHalf(p); throw new Error("SIGKILL"); };

    await measureThenCut(repo, checks, realGit, killed);

    expect(listed(repo)).toHaveLength(1);
    const res = await land(repo);
    expect(res.status).toBe("merged");
    // The next checkout of the same card sweeps what the cut left behind.
    await measureThenCut(repo, checks, realGit);
    expect(readdirSync(checks)).toEqual([]);
  }, WITH_REAL_GIT);

  test("cut between the move and the prune", async () => {
    const { repo, checks } = repoWithNodeBranch();
    let pruned = 0;
    const cut: DiscardGit = async (cwd, args) => {
      // The release's own prune never runs: the process died right after the rename.
      if (args[0] === "worktree" && args[1] === "prune" && ++pruned === 2) return { code: 137 };
      return realGit(cwd, args);
    };

    await measureThenCut(repo, checks, cut);

    const res = await land(repo);
    expect(res.status).toBe("merged");
    expect(listed(repo)).toHaveLength(1);
  }, WITH_REAL_GIT);
});

describe("the measure is pinned to the delivered commit, not to the branch tip", () => {
  test("HEAD stays on the delivered commit even if the branch advances during the measure", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const deliveredCommit = git(repo, "rev-parse", BRANCH).trim();

    const lease = await openNodeCheckWorktree({
      git: realGit, repoPath: repo, commit: deliveredCommit, root: checks, taskId: "race-test",
      resolveHead: async (cwd) => git(cwd, "rev-parse", "HEAD").trim(),
    });
    expect(lease).not.toBeNull();

    // The branch moves on while the measure is in flight: a new delivery, or the land's own realign.
    git(repo, "switch", "-q", BRANCH);
    writeFileSync(join(repo, "server", "second-delivery.txt"), "second delivery\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "second node delivery");
    git(repo, "switch", "-q", "main");
    expect(git(repo, "rev-parse", BRANCH).trim()).not.toBe(deliveredCommit);

    expect(await lease!.head()).toBe(deliveredCommit);
    expect(existsSync(join(lease!.cwd, "server", "second-delivery.txt"))).toBe(false);
    await lease!.release();
  }, WITH_REAL_GIT);
});

describe("a planted branch already checked out elsewhere does not stop the node check", () => {
  test("the main checkout sitting on the branch does not block a detached measure", async () => {
    const { repo, checks } = repoWithNodeBranch();
    // The planted branch is already checked out in the project's own checkout:
    // `git worktree add <branch>` would refuse this, but a detached checkout on
    // the delivered COMMIT never claims the branch, so it is never refused.
    git(repo, "switch", "-q", BRANCH);
    const commit = git(repo, "rev-parse", BRANCH).trim();

    const lease = await openNodeCheckWorktree({
      git: realGit, repoPath: repo, commit, root: checks, taskId: "90cd0fcd-test",
      resolveHead: async (cwd) => git(cwd, "rev-parse", "HEAD").trim(),
    });

    expect(lease).not.toBeNull();
    expect(git(lease!.cwd, "rev-parse", "HEAD").trim()).toBe(commit);
    await lease!.release();
  }, WITH_REAL_GIT);
});

/** Every path `git worktree list` still shows for `repo`, the main checkout included. */
function listed(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain").split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length).trim());
}

/** A checkout of its own branch for card `id`, as the meter opens it. */
function checkoutFor(repo: string, checks: string, id: string): string {
  const path = join(checks, id);
  git(repo, "branch", `topics/card-${id}`, BRANCH);
  git(repo, "worktree", "add", "-q", path, `topics/card-${id}`);
  return path;
}

const headOf = async (cwd: string) => git(cwd, "rev-parse", "HEAD").trim();

describe("no node check checkout outlives the server that opened it", () => {
  test("the boot sweep removes what a dead process left, from the disk and from git", async () => {
    const { repo, checks } = repoWithNodeBranch();
    // The process died mid-measure: whole, clean, registered on the card branch.
    checkoutFor(repo, checks, "aaaaaaaa");
    // A restart cut the release after its rename: a copy aside, a registration pointing nowhere.
    const cut = checkoutFor(repo, checks, "bbbbbbbb");
    renameSync(cut, `${cut}.discarded-4242-x1`);
    // The macOS $TMPDIR cleaner emptied it after three days: no `.git` file, files half gone.
    const emptied = checkoutFor(repo, checks, "cccccccc");
    deleteHalf(emptied);
    unlinkSync(join(emptied, ".git"));
    expect(listed(repo)).toHaveLength(4);

    const pool = createNodeCheckWorktrees({ git: realGit, root: checks, resolveHead: headOf });
    const gone = await pool.sweep();

    expect(gone.map((p) => p.slice(checks.length + 1)).sort()).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
    expect(readdirSync(checks)).toEqual([]);
    expect(listed(repo)).toHaveLength(1);
    // The card branches are free again: nothing holds them checked out.
    expect(git(repo, "branch", "-D", "topics/card-aaaaaaaa")).toContain("Deleted");
  }, WITH_REAL_GIT);

  test("a release cut right after its rename: the copy moved aside goes, and its registration with it", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const cut = checkoutFor(repo, checks, "eeeeeeee");
    renameSync(cut, `${cut}.discarded-4242-x2`);
    expect(listed(repo)).toHaveLength(2);

    const pool = createNodeCheckWorktrees({ git: realGit, root: checks, resolveHead: headOf });
    await pool.sweep();

    expect(readdirSync(checks)).toEqual([]);
    expect(listed(repo)).toHaveLength(1);
  }, WITH_REAL_GIT);

  test("a checkout this process holds survives the sweep, even one opened in the same instant", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const pool = createNodeCheckWorktrees({ git: realGit, root: checks, resolveHead: headOf });
    // The previous process left this card's folder and another one; neither
    // one's name is a run folder, so they are both stale, even the one
    // sharing the card id the new measure below is about to open.
    checkoutFor(repo, checks, "dddddddd");
    const leftover = join(checks, "8e9c2873");
    mkdirSync(leftover);
    writeFileSync(join(leftover, "stale.txt"), "left by a dead process\n");

    // A node delivery reported right after boot: the measure opens while the sweep runs.
    const [lease, gone] = await Promise.all([
      pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "8e9c2873-test" }),
      pool.sweep(),
    ]);

    expect(gone.map((p) => p.slice(checks.length + 1)).sort()).toEqual(["8e9c2873", "dddddddd"]);
    expect(lease).not.toBeNull();
    // Its own run folder, not the stale one sharing the card prefix.
    expect(basename(lease!.cwd)).not.toBe("8e9c2873");
    expect(basename(lease!.cwd).startsWith("8e9c2873-")).toBe(true);
    expect(existsSync(join(lease!.cwd, "server", "delivered.txt"))).toBe(true);
    expect(git(lease!.cwd, "status", "--porcelain").trim()).toBe("");
    expect(await pool.sweep()).toEqual([]);
    expect(listed(repo)).toHaveLength(2);

    await lease!.release();
    expect(readdirSync(checks)).toEqual([]);
    expect(listed(repo)).toHaveLength(1);
  }, WITH_REAL_GIT);

  test("two measures of the same card overlap without either one losing its folder", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const pool = createNodeCheckWorktrees({ git: realGit, root: checks, resolveHead: headOf });

    const [first, second] = await Promise.all([
      pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "3d189f49-test" }),
      pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "3d189f49-test" }),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The bug: both runs computed the same path, so the second one's
    // pre-add discard deleted the folder the first one was still using.
    expect(first!.cwd).not.toBe(second!.cwd);
    expect(existsSync(first!.cwd)).toBe(true);
    expect(existsSync(second!.cwd)).toBe(true);
    expect(git(first!.cwd, "status", "--porcelain").trim()).toBe("");
    expect(git(second!.cwd, "status", "--porcelain").trim()).toBe("");

    await first!.release();
    expect(existsSync(second!.cwd)).toBe(true);
    expect(git(second!.cwd, "status", "--porcelain").trim()).toBe("");
    await second!.release();
    expect(readdirSync(checks)).toEqual([]);
  }, WITH_REAL_GIT);

  test("an open waits for the boot sweep's git, so a prune cannot pull the ground from under its add", async () => {
    const { repo, checks } = repoWithNodeBranch();
    checkoutFor(repo, checks, "ffffffff");
    const events: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let held = false;
    const traced: DiscardGit = async (cwd, args) => {
      const name = `${args[0]} ${args[1]}`;
      events.push(`start ${name}`);
      // The sweep's prune is held: in production it is a process that runs beside whatever starts meanwhile.
      if (name === "worktree prune" && !held) { held = true; await gate; }
      const out = await realGit(cwd, args);
      events.push(`end ${name}`);
      return out;
    };
    const pool = createNodeCheckWorktrees({ git: traced, root: checks, resolveHead: headOf });

    const swept = pool.sweep();
    const opened = pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "8e9c2873-test" });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(events).not.toContain("start worktree add");
    openGate();
    const [gone, lease] = await Promise.all([swept, opened]);

    expect(gone.map((p) => p.slice(checks.length + 1))).toEqual(["ffffffff"]);
    expect(lease).not.toBeNull();
    expect(events.indexOf("start worktree add")).toBeGreaterThan(events.indexOf("end worktree prune"));
    await lease!.release();
    expect(listed(repo)).toHaveLength(1);
  }, WITH_REAL_GIT);

  test("a worktree add killed half-way leaves nothing behind, and the card opens again", async () => {
    const { repo, checks } = repoWithNodeBranch();
    let killed = false;
    const killAdd: DiscardGit = async (cwd, args) => {
      const out = await realGit(cwd, args);
      if (args[0] === "worktree" && args[1] === "add" && !killed) {
        // SIGKILL mid-checkout: half the files written, and the registration
        // still "locked initializing", which git removes only when the add ends.
        killed = true;
        const tree = args.find((a, i) => i >= 2 && !a.startsWith("-"))!;
        deleteHalf(tree);
        writeFileSync(join(repo, ".git", "worktrees", basename(tree), "locked"), "initializing\n");
        return { code: 137 };
      }
      return out;
    };
    const pool = createNodeCheckWorktrees({ git: killAdd, root: checks, resolveHead: headOf });

    expect(await pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "082df06d-test" })).toBeNull();

    expect(readdirSync(checks)).toEqual([]);
    expect(listed(repo)).toHaveLength(1);
    const again = await pool.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "082df06d-test" });
    expect(again).not.toBeNull();
    expect(git(again!.cwd, "status", "--porcelain").trim()).toBe("");
    await again!.release();
  }, WITH_REAL_GIT);

  test("the boot sweep of a test server never reaches production's checkouts", async () => {
    const { repo, checks } = repoWithNodeBranch();
    // Each server's worktree root derives from its own Topics home, so the checkouts of an e2e server and of
    // production are in different folders even though both live under `_scratch/node-checks`.
    const prodRoot = nodeCheckRoot(join(checks, "..", "prod-home", "worktrees"));
    const e2eRoot = nodeCheckRoot(join(checks, "..", "e2e-home", "worktrees"));
    expect(prodRoot).toBe(join(checks, "..", "prod-home", "worktrees", "_scratch", "node-checks"));
    expect(e2eRoot).not.toBe(prodRoot);

    const prod = createNodeCheckWorktrees({ git: realGit, root: prodRoot, resolveHead: headOf });
    const lease = await prod.open({ repoPath: repo, commit: git(repo, "rev-parse", BRANCH).trim(), taskId: "8e9c2873-test" });
    expect(lease).not.toBeNull();

    const e2e = createNodeCheckWorktrees({ git: realGit, root: e2eRoot, resolveHead: headOf });
    expect(await e2e.sweep()).toEqual([]);

    expect(git(lease!.cwd, "status", "--porcelain").trim()).toBe("");
    expect(listed(repo)).toHaveLength(2);
    await lease!.release();
  }, WITH_REAL_GIT);
});
