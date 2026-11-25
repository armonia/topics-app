/**
 * The cleanup preview as the Settings list reads it (change worktree-standard, T7):
 * the plan of `worktree-gc-passes` with project names added and the shape the wire
 * carries. Pure, so the mapping is tested without a runner.
 */
import type { WorktreePlanPayload, WorktreePlanEntryPayload } from "../../shared/worktree-plan";
import type { GcPlan } from "./worktree-gc-passes";

export function toPlanPayload(plan: GcPlan, projectName: (projectId: string) => string | null): WorktreePlanPayload {
  const entries: WorktreePlanEntryPayload[] = plan.entries.map((e) => ({
    absPath: e.absPath,
    projectId: e.projectId,
    projectName: e.projectId ? projectName(e.projectId) : null,
    rowId: e.rowId,
    cls: e.cls,
    rootAction: e.action,
    plannedAction: e.planned?.action ?? null,
    reason: e.planned?.action === "keep" && e.planned.reason ? e.planned.reason : e.reason,
    bytes: e.bytes,
    from: e.from ?? null,
  }));
  return {
    entries,
    foreignCount: entries.filter((e) => e.cls === "foreign").length,
    scanMs: Math.round(plan.scanMs),
    overCap: plan.overCap.map((o) => ({ ...o, projectName: projectName(o.projectId) })),
  };
}
