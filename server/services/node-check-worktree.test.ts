/**
 * @covers LAND-04
 *
 * A node check checkout cut mid-release must not block the land (card 8e9c2873).
 *
 * @covers LAND-19
 *
 * The shutdown path: `stopReviewChecks` ends the round, the meter's `finally`
 * releases the checkout, and `process.exit` reaps the git it started. Here the
 * cut is simulated at every place it can land, on a real repository, and then
 * the same land a review approval runs is asked to merge the branch.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openNodeCheckWorktree } from "./node-check-worktree";
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

/** Every worktree git still lists on the card branch, with what `git status` says in it. */
function branchTrees(repo: string): Array<{ path: string; dirt: string }> {
  const out: Array<{ path: string; dirt: string }> = [];
  let path = "";
  for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${BRANCH}` && existsSync(path)) {
      out.push({ path, dirt: git(path, "status", "--porcelain").trim() });
    }
  }
  return out;
}

async function measureThenCut(repo: string, checks: string, cutGit: DiscardGit, cutDelete?: (p: string) => Promise<void>) {
  const lease = await openNodeCheckWorktree({
    git: cutGit, repoPath: repo, branch: BRANCH, root: checks, taskId: "8e9c2873-test",
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

    for (const t of branchTrees(repo)) expect(t.dirt).toBe("");
    const res = await land(repo);
    expect(res.status).toBe("merged");
    expect(git(repo, "merge-base", "--is-ancestor", BRANCH, "main")).toBe("");
  }, WITH_REAL_GIT);

  test("cut while the moved-aside copy is deleted", async () => {
    const { repo, checks } = repoWithNodeBranch();
    const killed = async (p: string) => { deleteHalf(p); throw new Error("SIGKILL"); };

    await measureThenCut(repo, checks, realGit, killed);

    expect(branchTrees(repo)).toEqual([]);
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
    for (const t of branchTrees(repo)) expect(t.dirt).toBe("");
  }, WITH_REAL_GIT);
});
