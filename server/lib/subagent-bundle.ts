/**
 * The parent's own work, as a git bundle, for a `spawn_agent` child about to
 * run on another machine (sottoagenti-nodo, traccia 3).
 *
 * THE TRANSPORT IS GIT, NOT A LIVE SYNC. A child on a node never sees the
 * parent's filesystem: it starts from a snapshot sent once, works on its own
 * branch there, and its branch comes back the same way. This mirrors the
 * card lane that already ships a branch as a bundle when a node cannot reach
 * origin (`bundleBranch`/`plantCarriedBranch`, `branch-on-origin.ts`,
 * `task-dispatcher-remote-node.ts:565`, `routes/nodes.ts:634-636`) — reused
 * here as is, because the wire format is the same bundle either way.
 *
 * WHAT IS NEW HERE is the snapshot itself: a child inherits uncommitted work
 * too (SUBAGENT-14: the parent's own worktree may be mid-edit), and the
 * parent's tree must stay exactly as the person left it while the child is
 * spawned. The working tree is written as a commit through a THROWAWAY INDEX
 * (`GIT_INDEX_FILE` in a temp dir: `read-tree HEAD`, `add -A`, `write-tree`,
 * `commit-tree`), so the parent's own index, stash list and files are never
 * touched. `git stash create` was the first version and lost new files that
 * were never added: it only snapshots tracked paths. Ignored files stay out,
 * as `.gitignore` says. The snapshot commit is bundled under a throwaway
 * branch name that is deleted again before this function returns: the
 * parent's checkout is left with no new ref, no new file, no new commit on
 * any branch it had.
 *
 * It works on a repo with no `origin` (an agent's home is one):
 * `bundleBranch` already falls back to a whole-history bundle when there is
 * no `origin/HEAD` to diff against.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPAWN_TIMEOUT } from "./bounded-spawn";
import { runGit } from "./run-git";
import { bundleBranch, carriedRef, isPlainBranchName } from "../services/branch-on-origin";
import type { GitRunner } from "../services/own-commits";

/**
 * `branchGit` with the extra environment passed through: the snapshot needs
 * `GIT_INDEX_FILE`, which `branchGit` drops, and a committer identity for
 * `commit-tree` on a machine that has none.
 */
const snapshotGit: GitRunner = (cwd, args, opts) =>
  runGit(cwd, args, { timeoutMs: SPAWN_TIMEOUT.commit, identity: true, env: { GIT_TERMINAL_PROMPT: "0", ...opts?.env } });

export interface ParentSnapshotInput {
  /** The parent's own checkout. Never written to beyond a ref that is removed before returning. */
  repoPath: string;
  /** A plain, throwaway branch name this call owns for the length of one snapshot. */
  snapshotBranch: string;
  /** Commits of origin's default to carry along for a receiver that has not fetched lately (`bundleBranch`). */
  marginCommits?: number;
  run?: GitRunner;
}

/**
 * The working tree as one commit on top of `HEAD`, built in a throwaway index
 * so the parent's own index is never read or written. Tracked edits, deletions
 * and new untracked files all go in; ignored files do not. `null` when any
 * step fails.
 */
async function workingTreeCommit(repoPath: string, head: string, run: GitRunner): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "topics-child-index-"));
  const env = { env: { GIT_INDEX_FILE: join(dir, "index") } };
  try {
    if ((await run(repoPath, ["read-tree", head], env)).code !== 0) return null;
    if ((await run(repoPath, ["add", "-A"], env)).code !== 0) return null;
    const tree = await run(repoPath, ["write-tree"], env);
    if (tree.code !== 0) return null;
    const commit = await run(repoPath, ["commit-tree", tree.stdout.trim(), "-p", head, "-m", "sub-agent snapshot of the parent's working tree"], env);
    return commit.code === 0 ? commit.stdout.trim() || null : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `HEAD` plus any uncommitted work, new untracked files included, as a git
 * bundle. `null` when the branch name is unusable or taken, or git could not
 * produce a bundle (an empty repo with nothing committed yet, `bundleBranch`'s
 * own case).
 */
export async function snapshotParentAsBundle(input: ParentSnapshotInput): Promise<Uint8Array | null> {
  const { repoPath, snapshotBranch } = input;
  const run = input.run ?? snapshotGit;
  if (!isPlainBranchName(snapshotBranch)) return null;
  const head = await run(repoPath, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) return null; // no commit yet: nothing to snapshot
  const snapshotSha = await workingTreeCommit(repoPath, head.stdout.trim(), run);
  if (!snapshotSha) return null;
  const tempRef = `refs/heads/${snapshotBranch}`;
  // The empty old value makes `update-ref` refuse when the ref already exists:
  // a name in use is never moved to the snapshot, with no window between a
  // check and the write for another process to slip into.
  const made = await run(repoPath, ["update-ref", tempRef, snapshotSha, ""]);
  if (made.code !== 0) return null;
  try {
    return await bundleBranch(repoPath, snapshotBranch, run, input.marginCommits ?? 0);
  } finally {
    // Always, even on a thrown error above: the parent's checkout must come
    // out of this call with exactly the branches it went in with.
    await run(repoPath, ["update-ref", "-d", tempRef]);
  }
}

export type MaterializeResult = { ok: true } | { ok: false; reason: string };

export interface AdoptCarriedBranchInput {
  /** The parent's own checkout, where `plantCarriedBranch` already landed the ref. */
  repoPath: string;
  branch: string;
  run?: GitRunner;
}

/**
 * Turns a bundle already planted as `carriedRef(branch)` (`plantCarriedBranch`,
 * `branch-on-origin.ts`) into an ordinary local branch in the parent's
 * checkout, so the child's work is addressable (`git show <branch>:<path>`,
 * a worktree checkout, a diff) the same way any other branch is.
 *
 * A branch of that name already in the parent only moves FORWARD: when the
 * child's tip does not contain it, adopting would drop the parent's commits,
 * so the call refuses and names the branch instead.
 */
export async function adoptCarriedBranch(input: AdoptCarriedBranchInput): Promise<MaterializeResult> {
  const { repoPath, branch } = input;
  const run = input.run ?? snapshotGit;
  if (!isPlainBranchName(branch)) return { ok: false, reason: "not a valid branch name" };
  const tip = await run(repoPath, ["rev-parse", "--verify", "-q", carriedRef(branch)]);
  if (tip.code !== 0) return { ok: false, reason: "no carried ref to adopt" };
  const ref = `refs/heads/${branch}`;
  // A branch checked out in the parent or in one of its worktrees is never
  // moved under it: `update-ref` would leave the files and the index at the
  // old commit, `git status` would show the child's work reversed, and the
  // parent's next commit would undo it without a word.
  const worktrees = await run(repoPath, ["worktree", "list", "--porcelain"]);
  if (worktrees.code !== 0) return { ok: false, reason: `git worktree list failed: ${(worktrees.stderr ?? "").trim()}` };
  if (worktrees.stdout.split("\n").some((line) => line.trim() === `branch ${ref}`)) {
    return { ok: false, reason: `branch ${branch} is checked out here: adopting it would move it under the open files` };
  }
  const current = await run(repoPath, ["rev-parse", "--verify", "-q", ref]);
  const old = current.code === 0 ? current.stdout.trim() : "";
  if (old) {
    const forward = await run(repoPath, ["merge-base", "--is-ancestor", old, tip.stdout.trim()]);
    if (forward.code !== 0) return { ok: false, reason: `branch ${branch} already exists here with commits the child's branch does not have` };
  }
  // Compare-and-swap on the value read above: a branch that moved meanwhile is not overwritten.
  const moved = await run(repoPath, ["update-ref", ref, tip.stdout.trim(), old]);
  if (moved.code !== 0) return { ok: false, reason: `git update-ref failed: ${(moved.stderr ?? "").trim()}` };
  return { ok: true };
}
