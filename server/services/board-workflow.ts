import type { Database } from "bun:sqlite";
import {
  GLOBAL_WORKFLOW_SCOPE,
  STAGE_CI,
  parseCiPhase,
  parseReviewerModels,
  parseScheduledReviewMinutes,
  type ReviewerModels,
  parsePersonPaths,
  resolveWorkflowRules,
  type BoardWorkflow,
  type CiPhaseMode,
  type PersonPath,
  type WorkflowRules,
  type WorkflowRulesRow,
} from "../../shared/workflow";

/**
 * The `board_workflow_rules` table (migration 20261114120000): the CI switch
 * and the board's paths a person must look at. A database without the table
 * reads as no row, and no row is the default (CI phase on, generic paths
 * only). The columns are not stored: they are the same for every board
 * (`WORKFLOW_COLUMNS`); the old `board_workflows` table is no longer read.
 */
/**
 * `ci_phase` kept its INTEGER column when the switch grew from two values to
 * three: 1 = before (what `true` always meant), 0 = off (`false`), 2 = after.
 * Rows written before the third value read the same, no migration.
 */
const CI_PHASE_COLUMN: Record<CiPhaseMode, number> = { before: 1, off: 0, after: 2 };
function ciPhaseFromColumn(v: number | null): CiPhaseMode | null {
  return (Object.keys(CI_PHASE_COLUMN) as CiPhaseMode[]).find((m) => CI_PHASE_COLUMN[m] === v) ?? null;
}
function ciPhaseToColumn(v: WorkflowRulesRow["ciPhase"]): number | null {
  const mode = parseCiPhase(v);
  return mode ? CI_PHASE_COLUMN[mode] : null;
}

export function readOwnWorkflowRules(db: Database, scope: string): WorkflowRulesRow | null {
  try {
    const r = db.prepare("SELECT ci_phase, person_paths, scheduled_review_minutes, reviewer_models FROM board_workflow_rules WHERE scope = ?").get(scope) as { ci_phase: number | null; person_paths: string | null; scheduled_review_minutes: number | null; reviewer_models: string | null } | null;
    if (!r) return null;
    let personPaths: PersonPath[] | null = null;
    if (r.person_paths) {
      try { personPaths = parsePersonPaths(JSON.parse(r.person_paths)); } catch { personPaths = null; }
      // A stored list that no longer reads is not "no paths": that would let the board's
      // interface land alone. It fails the read, and the land asks a person.
      if (personPaths === null) throw new Error(`board_workflow_rules: unreadable person_paths for ${scope}`);
    }
    let reviewerModels: ReviewerModels | null = null;
    if (r.reviewer_models) { try { reviewerModels = parseReviewerModels(JSON.parse(r.reviewer_models)); } catch { reviewerModels = null; } }
    return { ciPhase: ciPhaseFromColumn(r.ci_phase), personPaths, scheduledReviewMinutes: parseScheduledReviewMinutes(r.scheduled_review_minutes), reviewerModels };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("board_workflow_rules:")) throw e;
    return null;
  }
}

export function readWorkflowRules(db: Database, projectId: string): WorkflowRules {
  const global = readOwnWorkflowRules(db, GLOBAL_WORKFLOW_SCOPE);
  if (projectId === GLOBAL_WORKFLOW_SCOPE) return resolveWorkflowRules({ global });
  return resolveWorkflowRules({ project: readOwnWorkflowRules(db, projectId), global });
}

/** Writes the fields present in `patch` (`null` = inherit); a row left with nothing is removed. */
export function writeWorkflowRules(db: Database, scope: string, patch: WorkflowRulesRow, nowIso: string): void {
  if (!scope) throw new Error("scope is required");
  if (patch.personPaths != null && parsePersonPaths(patch.personPaths) === null) throw new Error("invalid personPaths");
  const cur = readOwnWorkflowRules(db, scope) ?? {};
  const next: WorkflowRulesRow = {
    ciPhase: patch.ciPhase !== undefined ? parseCiPhase(patch.ciPhase) : cur.ciPhase ?? null,
    personPaths: patch.personPaths !== undefined ? patch.personPaths : cur.personPaths ?? null,
    scheduledReviewMinutes: patch.scheduledReviewMinutes !== undefined ? parseScheduledReviewMinutes(patch.scheduledReviewMinutes) : cur.scheduledReviewMinutes ?? null,
    reviewerModels: patch.reviewerModels !== undefined ? (patch.reviewerModels === null ? null : parseReviewerModels(patch.reviewerModels)) : cur.reviewerModels ?? null,
  };
  const hasModels = !!next.reviewerModels && Object.keys(next.reviewerModels).length > 0;
  if (next.ciPhase == null && (next.personPaths == null || next.personPaths.length === 0) && next.scheduledReviewMinutes == null && !hasModels) {
    db.prepare("DELETE FROM board_workflow_rules WHERE scope = ?").run(scope);
    return;
  }
  db.prepare(
    `INSERT INTO board_workflow_rules (scope, ci_phase, person_paths, scheduled_review_minutes, reviewer_models, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET ci_phase = excluded.ci_phase, person_paths = excluded.person_paths, scheduled_review_minutes = excluded.scheduled_review_minutes, reviewer_models = excluded.reviewer_models, updated_at = excluded.updated_at`,
  ).run(scope, ciPhaseToColumn(next.ciPhase), next.personPaths?.length ? JSON.stringify(parsePersonPaths(next.personPaths)) : null, next.scheduledReviewMinutes ?? null, hasModels ? JSON.stringify(next.reviewerModels) : null, nowIso);
}

/**
 * A stage named by a caller, checked against the board's workflow: it must be
 * one of its columns, and agree with the status the card is getting. `stage`
 * is what to store (`null` for a plain column, whose id is its status).
 */
export function checkStage(
  columns: BoardWorkflow["columns"], stage: string, status: string | undefined,
): { stage: string | null } | { error: string } {
  // The CI column is entered by accepting the work (Approva, Landa), never by naming it: a drag there would skip the land.
  if (stage === STAGE_CI) return { error: `the "${STAGE_CI}" column is entered by approving or landing the card, not by moving it there` };
  const col = columns.find((c) => c.id === stage);
  if (!col) return { error: `stage "${stage}" is not a column of this board's workflow (${columns.map((c) => c.id).join(", ")})` };
  if (status !== undefined && status !== col.base) return { error: `stage "${stage}" holds cards in status "${col.base}", not "${status}"` };
  return { stage: col.id === col.base ? null : col.id };
}
