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
