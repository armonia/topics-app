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
 * spawned. `git stash create` writes that tree as a commit object WITHOUT
 * touching the index or the working tree (unlike `git stash push`), so
 * nothing here ever runs `stash pop` or `stash apply` on the parent's own
 * checkout. The snapshot commit is bundled under a throwaway branch name
 * that is deleted again before this function returns: the parent's checkout
 * is left with no new ref, no new file, no new commit on any branch it had.
 *
 * It works on a repo with no `origin` (the `~/.claude/jarvis/home` case):
 * `bundleBranch` already falls back to a whole-history bundle when there is
 * no `origin/HEAD` to diff against.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchGit, bundleBranch, carriedRef, isPlainBranchName } from "../services/branch-on-origin";
import type { GitRunner } from "../services/own-commits";

export interface ParentSnapshotInput {
  /** The parent's own checkout. Never written to beyond a ref that is removed before returning. */
  repoPath: string;
  /** A plain, throwaway branch name this call owns for the length of one snapshot. */
  snapshotBranch: string;
  run?: GitRunner;
}

/**
 * `HEAD` plus any uncommitted work, as a git bundle. `null` when the branch
 * name is unusable or git could not produce a bundle (an empty repo with
 * nothing committed yet, `bundleBranch`'s own case).
 */
export async function snapshotParentAsBundle(input: ParentSnapshotInput): Promise<Uint8Array | null> {
  const { repoPath, snapshotBranch } = input;
  const run = input.run ?? branchGit;
  if (!isPlainBranchName(snapshotBranch)) return null;
  const head = await run(repoPath, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) return null; // no commit yet: nothing to snapshot
  const tempRef = `refs/heads/${snapshotBranch}`;
  // A name already in use would have `update-ref` silently move someone's
  // real branch to the snapshot's tip instead of refusing: checked first, so
  // the caller's throwaway name can never collide with one that matters.
  const existing = await run(repoPath, ["rev-parse", "--verify", "-q", tempRef]);
  if (existing.code === 0) return null;
  // `stash create` answers with the snapshot commit's sha on stdout, or an
  // empty line when the tree has nothing uncommitted — HEAD is then the
  // whole snapshot, which is still correct and still needs no stash at all.
  const stashed = await run(repoPath, ["stash", "create"]);
  const snapshotSha = (stashed.code === 0 ? stashed.stdout.trim() : "") || head.stdout.trim();
  const made = await run(repoPath, ["update-ref", tempRef, snapshotSha]);
  if (made.code !== 0) return null;
  try {
    return await bundleBranch(repoPath, snapshotBranch, run);
  } finally {
    // Always, even on a thrown error above: the parent's checkout must come
    // out of this call with exactly the branches it went in with.
    await run(repoPath, ["update-ref", "-d", tempRef]);
  }
}

export interface MaterializeChildCheckoutInput {
  /** An empty or non-existent directory: this call runs `git init` in it. */
  targetDir: string;
  /** The branch name the snapshot bundle carries, becomes the child's starting branch. */
  branch: string;
  bytes: Uint8Array;
  run?: GitRunner;
}

export type MaterializeResult = { ok: true } | { ok: false; reason: string };

/**
 * Bootstraps the child's own checkout from a snapshot bundle, from scratch.
 * Unlike a card's node (already a clone of `origin`), a child spawned from a
 * repo with no `origin` hands the node nothing to clone: this is the one
 * place the node's checkout is born, by fetching the bundle into a brand new
 * `git init`.
 */
export async function materializeChildCheckout(input: MaterializeChildCheckoutInput): Promise<MaterializeResult> {
  const { targetDir, branch, bytes } = input;
  const run = input.run ?? branchGit;
  if (!isPlainBranchName(branch)) return { ok: false, reason: "not a valid branch name" };
  // A fetch into the branch currently checked out is refused by git, so init
  // starts on an unrelated placeholder and only checks `branch` out once the
  // fetch has it.
  const init = await run(targetDir, ["init", "-q", "-b", "__topics-bootstrap__"]);
  if (init.code !== 0) return { ok: false, reason: `git init failed: ${(init.stderr ?? "").trim()}` };
  const dir = await mkdtemp(join(tmpdir(), "topics-child-bundle-"));
  try {
    const file = join(dir, "snapshot.bundle");
    await writeFile(file, bytes);
    const verified = await run(targetDir, ["bundle", "verify", file]);
    if (verified.code !== 0) return { ok: false, reason: `invalid bundle: ${(verified.stderr ?? "").trim().slice(-160)}` };
    const fetched = await run(targetDir, ["fetch", "--no-tags", file, `${branch}:refs/heads/${branch}`]);
    if (fetched.code !== 0) return { ok: false, reason: `fetch from bundle failed: ${(fetched.stderr ?? "").trim().slice(-160)}` };
    const checkedOut = await run(targetDir, ["checkout", "-q", branch]);
    if (checkedOut.code !== 0) return { ok: false, reason: `checkout failed: ${(checkedOut.stderr ?? "").trim().slice(-160)}` };
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
 */
export async function adoptCarriedBranch(input: AdoptCarriedBranchInput): Promise<MaterializeResult> {
  const { repoPath, branch } = input;
  const run = input.run ?? branchGit;
  if (!isPlainBranchName(branch)) return { ok: false, reason: "not a valid branch name" };
  const tip = await run(repoPath, ["rev-parse", "--verify", "-q", carriedRef(branch)]);
  if (tip.code !== 0) return { ok: false, reason: "no carried ref to adopt" };
  const moved = await run(repoPath, ["branch", "-f", branch, tip.stdout.trim()]);
  if (moved.code !== 0) return { ok: false, reason: `git branch failed: ${(moved.stderr ?? "").trim()}` };
  return { ok: true };
}
