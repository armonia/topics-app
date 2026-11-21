/**
 * A land that found nothing to merge: when a person's approval closes the card,
 * and why the same empty land is never asked twice.
 */
import type { TasksCore } from "./tasks-scope";
import type { TaskService } from "../services/tasks";
import type { TasksRouterOpts } from "./tasks-opts";
import { ownCommitFiles } from "./tasks-git";

export interface NothingToLandDeps {
  svc: TaskService;
  broadcastToAll: TasksCore["broadcastToAll"];
  opts: Pick<TasksRouterOpts, "taskCheckoutRef" | "ownCommitFiles"> | undefined;
  /** The old behaviour: a note, the card stays in review. */
  explain: (projectId: string, taskId: string, reason: string) => void;
}

export function createNothingToLand(deps: NothingToLandDeps) {
  const { svc, broadcastToAll, opts, explain } = deps;

  /**
   * True only when the branch is VERIFIED to carry no commit of its own (content
   * against main, not ancestry). A deduced "landed" over an empty merge can mean
   * the work is not on main (card 572f8a09), so unknown counts as "has commits".
   * Call it BEFORE the worktree is reaped.
   */
  async function branchHasNoOwnCommits(taskId: string): Promise<boolean> {
    try {
      const ref = await opts?.taskCheckoutRef?.(taskId);
      if (!ref) return false;
      const files = await (opts?.ownCommitFiles ?? ownCommitFiles)(ref.cwd);
      return Array.isArray(files) && files.length === 0;
    } catch { return false; }
  }

  /**
   * The land decision is always dropped, or the review sweep puts the card back
   * in the CI phase every ten minutes for the same empty land. A person's land
   * (no `recheck`) on a branch verified empty is an explicit approval of a card
   * that carries no code: it closes with the note saying why. Anything else stays
   * in review with the explanation.
   */
  function settle(
    projectId: string, taskId: string, reason: string,
    o: { recheck?: unknown; verifiedEmpty: boolean },
  ): void {
    try { svc.setLandIntent({ taskId, who: null }); } catch (err) { console.warn(`[land] land decision not cleared for ${taskId}:`, err); }
    const cur = svc.get(taskId, { projectId })?.task;
    if (!cur || cur.status !== "review" || o.recheck || !o.verifiedEmpty) return explain(projectId, taskId, reason);
    try {
      svc.addComment({ taskId, author: "system", content: `Niente da fondere (${reason}): approvata da una persona, la card si chiude senza land.` });
      const done = svc.reviewDecision({ taskId, by: "user", decision: "approve", projectId });
      broadcastToAll({ type: "task:updated", projectId, task: svc.get(taskId, { projectId })?.task ?? done });
    } catch (err) {
      console.warn(`[land] approval without commits failed for ${taskId}:`, err);
      explain(projectId, taskId, reason);
    }
  }

  return { branchHasNoOwnCommits, settle };
}
