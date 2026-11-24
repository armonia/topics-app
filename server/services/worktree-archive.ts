/**
 * Archive ref for the commits of a task that was closed without a land.
 *
 * The worktree GC used to land such a branch into main before reaping it. A
 * card closed on purpose WITHOUT a land (decided in review) is not a debt: its
 * commits must never reach main. The only thing the GC may do for them is keep
 * them reachable under a ref nobody merges from, then free the checkout.
 */
import { gitExit, gitOut } from "./branch-status";
import type { GitRunner } from "./own-commits";

export const ARCHIVE_REF_PREFIX = "refs/topics/archive/";

/**
 * Point `refs/topics/archive/<taskId>` at the tip of `branch`. Returns true only
 * when the ref resolves to that very commit afterwards (read back, not assumed).
 */
export async function archiveBranchRef(
  repoPath: string,
  branch: string,
  taskId: string,
  run?: GitRunner,
): Promise<boolean> {
  const tip = (await gitOut(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], run)).trim();
  if (!tip) return false;
  const ref = `${ARCHIVE_REF_PREFIX}${taskId}`;
  if ((await gitExit(repoPath, ["update-ref", ref, tip], run)) !== 0) return false;
  const back = (await gitOut(repoPath, ["rev-parse", "--verify", ref], run)).trim();
  return back === tip;
}

/**
 * The two places an archive lives (cross-node addendum, B4): the GC pins under
 * `refs/topics/archive/*`, the Claude Code worktree hook tags `archive/wt-*`
 * (the repository's documented tag convention for archived branches). One per
 * hand, and the question «is this commit already archived?» must read both, or
 * a checkout the hook archived reads as unarchived.
 */
export const ARCHIVE_REF_PREFIXES: readonly string[] = ["refs/topics/archive/", "refs/tags/archive/wt-"];

/** True when some archive ref, in either namespace, contains `sha`. False when git cannot tell. */
export async function alreadyArchived(repoPath: string, sha: string, run?: GitRunner): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  const out = await gitOut(repoPath, ["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/topics/archive", "refs/tags/archive"], run);
  return out.split("\n").some((ref) => ARCHIVE_REF_PREFIXES.some((ns) => ref.startsWith(ns)));
}
