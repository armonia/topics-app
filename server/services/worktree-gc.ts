/**
 * Worktree garbage collection — the ORIGIN fix for worktree pile-up.
 *
 * Worktrees were only ever reaped on a successful approve→automerge (routes/
 * tasks.ts). Everything that finished WITHOUT that exact path leaked forever:
 * a task rejected then abandoned, a task deleted, an approve that the (old)
 * dirty-main bug skipped, an orphaned dispatch. 27 stale worktrees had piled
 * up by 2026-07-18.
 *
 * This sweep applies the SAME safety contract as the approve-time reap to the
 * whole population, periodically. The contract lives in `decideWorktreeReap`
 * as a pure function so it is exhaustively unit-testable: we only ever destroy
 * a worktree when there is provably nothing to lose.
 *
 * Never reaped: a worktree whose task is still active (backlog/todo/
 * in_progress/review), one with real uncommitted work (junk excluded), one
 * with unmerged commits when we can't safely land them, or one under a live
 * agent turn. A closed task whose clean commits never landed is re-merged
 * first (land-then-reap), never dropped.
 */

export type WorktreeReapAction = "reap" | "land-then-reap" | "keep";

export interface WorktreeReapDecision {
  action: WorktreeReapAction;
  reason: string;
}

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export interface WorktreeReapInput {
  /** Bound task status, or null when the worktree is orphaned (no task/topic). */
  taskStatus: TaskStatus | null;
  /** Bound task archived flag (archived tasks are terminal regardless of status). */
  taskArchived: boolean;
  /** Non-junk uncommitted paths present (from worktreeRealDirt). */
  hasRealDirt: boolean;
  /** Worktree tip is an ancestor of main → no unmerged commits to lose. */
  mergedIntoMain: boolean;
  /** The task's board opted into auto-merge (so land-then-reap is allowed). */
  autoMergeEnabled: boolean;
  /** Only `branch`-mode worktrees own a landable branch. */
  mode: "branch" | "reuse" | "detached";
}

/**
 * The safety contract. Pure. Order matters — each guard is a reason NOT to
 * destroy, checked before any reap is allowed.
 */
export function decideWorktreeReap(input: WorktreeReapInput): WorktreeReapDecision {
  // A task that is still being worked or is awaiting human review owns its
  // worktree — never touch it. Orphans (taskStatus === null) ARE terminal.
  const terminal = input.taskStatus === null || input.taskStatus === "done" || input.taskArchived;
  if (!terminal) return { action: "keep", reason: `task '${input.taskStatus}' attivo` };

  // Real uncommitted work sitting in the tree is the only copy — a closed task
  // can still carry it (a system-forced review). Human decides; we don't nuke.
  if (input.hasRealDirt) return { action: "keep", reason: "modifiche non committate (junk escluso)" };

  // Fully on main already → the worktree holds nothing main doesn't. Safe.
  if (input.mergedIntoMain) return { action: "reap", reason: "già interamente su main" };

  // Closed task, clean tree, but commits never landed (e.g. an approve the
  // old dirty-main bug skipped). Land them first, THEN reap — never drop.
  if (input.autoMergeEnabled && input.mode === "branch") {
    return { action: "land-then-reap", reason: "task chiuso con commit non ancora su main" };
  }

  // Unmerged commits we can't safely auto-land (automerge off / non-branch).
  // Keep for an explicit human decision rather than lose the commits.
  return { action: "keep", reason: "commit non mergiati, automerge non disponibile → decisione umana" };
}

// ─────────────────────────────────────────────────────────────────────────

export interface GcWorktree {
  id: string;
  projectId: string;
  absPath: string;
  branchName: string | null;
  mode: "branch" | "reuse" | "detached";
}

/** Branch state read from the PROJECT repo (robust to a removed worktree dir). */
export type BranchStatus = "gone" | "merged" | "unmerged";

export interface WorktreeGcDeps {
  /** Ready worktrees to consider (the manager's store, status='ready'). */
  listWorktrees: () => GcWorktree[];
  /**
   * Resolve the task bound to a worktree (worktree → topic → task).
   * `null` task ⇒ orphan. Returns the bits the decision needs.
   */
  resolveTask: (worktreeId: string) =>
    | { taskId: string; status: TaskStatus; archived: boolean }
    | { taskId: null };
  /** True while a dispatched turn for the task is in flight — never reap under it. */
  isBusy: (taskId: string) => boolean;
  /** Whether the worktree directory still exists on disk. */
  diskPresent: (absPath: string) => boolean;
  /** Non-junk uncommitted paths (worktreeRealDirt). Only meaningful when disk present. */
  realDirt: (absPath: string) => Promise<string[]>;
  /**
   * The branch's state relative to main, read from the project repo (so it's
   * correct even after the worktree dir was removed): `gone` (branch deleted),
   * `merged` (ancestor of main → nothing to lose), or `unmerged`.
   */
  branchStatus: (wt: GcWorktree) => Promise<BranchStatus>;
  /** The worktree's board opted into auto-merge. */
  autoMergeEnabled: (projectId: string) => boolean;
  /** Land the task's branch. Returns the coarse outcome. */
  tryLand: (taskId: string) => Promise<"landed" | "nothing" | "conflict" | "skipped">;
  /** Reap worktree + branch + row (worktreeManager.delete). */
  reap: (worktreeId: string) => Promise<boolean>;
  log: (msg: string) => void;
}

export interface WorktreeGcSummary {
  total: number;
  reaped: number;
  landed: number;
  kept: number;
  errors: number;
}

/**
 * One sweep pass. Best-effort and side-effect-isolated: any single worktree
 * failing (git hiccup, race with a manual delete) is logged and skipped, never
 * aborting the rest.
 */
export async function sweepWorktrees(deps: WorktreeGcDeps): Promise<WorktreeGcSummary> {
  const worktrees = deps.listWorktrees();
  const summary: WorktreeGcSummary = { total: worktrees.length, reaped: 0, landed: 0, kept: 0, errors: 0 };

  for (const wt of worktrees) {
    try {
      const t = deps.resolveTask(wt.id);
      const taskId = t.taskId;

      // Never reap under a live turn, even if the task row reads terminal.
      if (taskId && deps.isBusy(taskId)) { summary.kept += 1; continue; }

      const branch = wt.mode === "branch" ? await deps.branchStatus(wt).catch(() => "unmerged" as BranchStatus) : "merged";

      // Ghost row: a `branch`-mode worktree whose branch is already gone holds
      // nothing — the disk dir (if any) is a leftover, the row is dead weight.
      // Reap directly (the manager prunes the missing dir + deletes the row).
      if (wt.mode === "branch" && branch === "gone") {
        const ok = await deps.reap(wt.id);
        if (ok) { summary.reaped += 1; deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — branch già sparito (riga fantasma)`); }
        else summary.errors += 1;
        continue;
      }

      // A removed worktree dir can hold no uncommitted work; only inspect the
      // tree for dirt when it actually exists.
      const present = deps.diskPresent(wt.absPath);
      const dirt = present ? await deps.realDirt(wt.absPath).catch(() => [] as string[]) : [];

      const decision = decideWorktreeReap({
        taskStatus: taskId ? (t as { status: TaskStatus }).status : null,
        taskArchived: taskId ? (t as { archived: boolean }).archived : false,
        hasRealDirt: dirt.length > 0,
        mergedIntoMain: branch === "merged",
        autoMergeEnabled: deps.autoMergeEnabled(wt.projectId),
        mode: wt.mode,
      });

      if (decision.action === "keep") { summary.kept += 1; continue; }

      if (decision.action === "land-then-reap") {
        // Needs a real task to land. An orphan (taskId null) with unmerged
        // commits can't be landed → keep it for a human rather than lose work.
        if (!taskId) { summary.kept += 1; continue; }
        const outcome = await deps.tryLand(taskId);
        if (outcome === "conflict" || outcome === "skipped") {
          deps.log(`[worktree-gc] keep ${wt.branchName ?? wt.id}: land ${outcome}`);
          summary.kept += 1;
          continue;
        }
        if (outcome === "landed") summary.landed += 1;
        // landed OR nothing (superseded) → the branch holds nothing to lose now.
      }

      const ok = await deps.reap(wt.id);
      if (ok) {
        summary.reaped += 1;
        deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — ${decision.reason}`);
      } else {
        summary.errors += 1;
      }
    } catch (err) {
      summary.errors += 1;
      deps.log(`[worktree-gc] error on ${wt.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  if (summary.reaped || summary.landed || summary.errors) {
    deps.log(
      `[worktree-gc] sweep done: ${summary.reaped} reaped, ${summary.landed} landed, ` +
      `${summary.kept} kept, ${summary.errors} errors (of ${summary.total})`,
    );
  }
  return summary;
}
