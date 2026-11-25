/**
 * THE CAP ON WORKTREES PER PROJECT (change worktree-standard, T4).
 *
 * The cap is a COUNT of worktrees, not a number of GB: `du` counts cloned blocks
 * twice, so a cap in GB would lie. Over the cap the cleanup acts in two steps:
 * first it slims the checkouts nobody is in (drops what regenerates), then it
 * reaps the OLDEST of the ones the safety contract admits, and stops as soon as
 * the project is back under the cap.
 *
 * This module only decides the order. What may really be removed is still decided
 * by `decideWorktreeReap` inside the sweep: the cap never loosens the contract.
 */

export interface CapRow {
  id: string;
  projectId: string;
  /** Row creation, ms. Older goes first. */
  createdAtMs: number;
  status: "pending" | "ready" | "error";
  /** Inside the worktree root: the cap counts Topics' own checkouts, not other tools'. */
  inRoot: boolean;
  /** A live turn, a session inside, or a task actually working: never touched. */
  exempt: boolean;
}

export interface CapPlan {
  projectId: string;
  /** Worktrees counted against the cap. */
  count: number;
  max: number;
  /** How many have to go for the project to be back at the cap. */
  excess: number;
  /** Candidates to slim first, oldest first. */
  slim: string[];
  /** Candidates to try to reap, oldest first; the caller stops once `excess` are gone. */
  reap: string[];
}

/**
 * One plan per project that is over `max`. Projects at or under the cap do not
 * appear. `error` rows and rows outside the root are not counted: the first hold
 * no checkout, the second are not Topics' to limit.
 */
export function planOverCap(rows: readonly CapRow[], max: number): CapPlan[] {
  const byProject = new Map<string, CapRow[]>();
  for (const r of rows) {
    if (!r.inRoot || r.status === "error") continue;
    const list = byProject.get(r.projectId) ?? [];
    list.push(r);
    byProject.set(r.projectId, list);
  }
  const plans: CapPlan[] = [];
  for (const [projectId, list] of byProject) {
    const excess = list.length - max;
    if (excess <= 0) continue;
    const candidates = list
      .filter((r) => !r.exempt && r.status === "ready")
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))
      .map((r) => r.id);
    plans.push({ projectId, count: list.length, max, excess, slim: candidates, reap: candidates });
  }
  return plans.sort((a, b) => b.excess - a.excess || (a.projectId < b.projectId ? -1 : 1));
}
