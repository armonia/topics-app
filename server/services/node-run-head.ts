import type { GitRunner } from "./own-commits";

/** `branchName` is the branch the worktree was BORN on; an agent may have checked out another since. */
export type NodeRunWorktreeLookup = (taskId: string) => { absPath: string; branchName: string | null; mode: "branch" | "reuse" | "detached" } | null;

/**
 * The run's worktree checked out a branch other than the one it was born on
 * (KANBAN-76 part 2): an agent that ran `git checkout -b` inside it left the
 * registered name pointing at the OLD tip, and bundling that name would hand
 * the origin board a branch planted on the run's real work's base — a
 * delivery that reads as empty while the work sits one `git log` away.
 *
 * `null` = no mismatch (or nothing to check: no worktree here, a `reuse` or
 * `detached` worktree has no branch of its own to compare).
 */
export async function nodeRunHeadMismatch(
  runGit: GitRunner,
  worktreeOfTask: NodeRunWorktreeLookup | undefined,
  taskId: string,
): Promise<string | null> {
  const wt = worktreeOfTask?.(taskId);
  if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
  const head = await runGit(wt.absPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const headBranch = head.code === 0 ? head.stdout.trim() : "";
  if (!headBranch || headBranch === wt.branchName) return null;
  return `il worktree della corsa è passato al ramo \`${headBranch}\`, non più su \`${wt.branchName}\`: non consegno il ramo registrato come se fosse nuovo, sistemalo a mano sul nodo.`;
}

/** The delivery ref of a run as the origin board may trust it: nulled out (with the reason) on a head mismatch. */
export async function nodeRunDelivery(
  runGit: GitRunner,
  worktreeOfTask: NodeRunWorktreeLookup | undefined,
  task: { id: string; deliveryBranch: string | null; deliveryCommit: string | null },
): Promise<{ branch: string | null; commit: string | null; reason: string | null }> {
  const reason = await nodeRunHeadMismatch(runGit, worktreeOfTask, task.id);
  return reason ? { branch: null, commit: null, reason } : { branch: task.deliveryBranch, commit: task.deliveryCommit, reason };
}
