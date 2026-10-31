import type { Database } from "bun:sqlite";
import {
  GLOBAL_WORKFLOW_SCOPE,
  STAGE_AI_REVIEW,
  isWorkflowPresetId,
  resolveWorkflow,
  type BoardWorkflow,
  type WorkflowPresetId,
} from "../../shared/workflow";

/**
 * The `board_workflows` table (migration 20261030225403): one preset per scope,
 * `'*'` global, any other scope a project id. The shapes and the rule (project
 * wins over global, nothing = `default`) live in `shared/workflow.ts`; this is
 * only the storage.
 *
 * Every read tolerates a database without the table (reduced test schemas, a
 * server that has not migrated yet): no table is no row, that is the default
 * workflow, and a board must never fail to open over its columns.
 */

function presetAt(db: Database, scope: string): string | null {
  try {
    const r = db.prepare("SELECT preset FROM board_workflows WHERE scope = ?").get(scope) as { preset: string } | null;
    return r?.preset ?? null;
  } catch {
    return null;
  }
}

export function readBoardWorkflow(db: Database, projectId: string): BoardWorkflow {
  const global = presetAt(db, GLOBAL_WORKFLOW_SCOPE);
  if (projectId === GLOBAL_WORKFLOW_SCOPE) return resolveWorkflow({ global });
  return resolveWorkflow({ project: presetAt(db, projectId), global });
}

/** The preset written for exactly this scope, without falling back (the picker's «inherit» state). */
export function readOwnWorkflowPreset(db: Database, scope: string): WorkflowPresetId | null {
  const p = presetAt(db, scope);
  return isWorkflowPresetId(p) ? p : null;
}

/** `null` removes the row: the project goes back to the global preset, the global one to `default`. */
export function writeBoardWorkflow(db: Database, scope: string, preset: WorkflowPresetId | null, nowIso: string): void {
  if (!scope) throw new Error("scope is required");
  if (preset === null) {
    db.prepare("DELETE FROM board_workflows WHERE scope = ?").run(scope);
    return;
  }
  if (!isWorkflowPresetId(preset)) throw new Error(`unknown workflow preset "${String(preset)}"`);
  db.prepare(
    `INSERT INTO board_workflows (scope, preset, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET preset = excluded.preset, updated_at = excluded.updated_at`,
  ).run(scope, preset, nowIso);
}

/**
 * After a workflow write: the cards on the boards it reaches (this one, or for
 * the global row every board without a row of its own) whose stage the
 * board's workflow no longer has go back to the default column of their
 * status. Returns their ids. A schema without the column has no stages.
 */
export function clearStagesOutsideWorkflow(db: Database, scope: string, nowIso: string): string[] {
  let rows: Array<{ id: string; project_id: string; stage: string }> = [];
  try {
    rows = (scope === GLOBAL_WORKFLOW_SCOPE
      ? db.prepare("SELECT id, project_id, stage FROM tasks WHERE stage IS NOT NULL AND project_id NOT IN (SELECT scope FROM board_workflows)").all()
      : db.prepare("SELECT id, project_id, stage FROM tasks WHERE stage IS NOT NULL AND project_id = ?").all(scope)
    ) as Array<{ id: string; project_id: string; stage: string }>;
  } catch { return []; }
  const columnsOf = new Map<string, BoardWorkflow["columns"]>();
  const cleared: string[] = [];
  for (const r of rows) {
    let columns = columnsOf.get(r.project_id);
    if (!columns) { columns = readBoardWorkflow(db, r.project_id).columns; columnsOf.set(r.project_id, columns); }
    if (columns.some((c) => c.id === r.stage)) continue;
    db.prepare("UPDATE tasks SET stage = NULL, updated_at = ? WHERE id = ?").run(nowIso, r.id);
    cleared.push(r.id);
  }
  return cleared;
}

/**
 * The cards left in AI review, untouched since `cutoffIso`, that the
 * coordinator was not reminded of since their last touch: each is stamped
 * (`ai_review_reminded_at`, `updated_at` left alone) in the statement that
 * re-checks it, so two passes cannot both return it. Returns their ids.
 */
export function stampStaleAiReview(db: Database, cutoffIso: string, nowIso: string): string[] {
  const fresh = "(ai_review_reminded_at IS NULL OR ai_review_reminded_at < updated_at)";
  let ids: Array<{ id: string }> = [];
  try {
    ids = db.prepare(
      `SELECT id FROM tasks WHERE archived = 0 AND status = 'review' AND stage = ? AND updated_at < ? AND ${fresh} ORDER BY updated_at`,
    ).all(STAGE_AI_REVIEW, cutoffIso) as Array<{ id: string }>;
  } catch { return []; }
  return ids.filter(({ id }) => db.prepare(
    `UPDATE tasks SET ai_review_reminded_at = ? WHERE id = ? AND status = 'review' AND stage = ? AND ${fresh}`,
  ).run(nowIso, id, STAGE_AI_REVIEW).changes > 0).map(({ id }) => id);
}
