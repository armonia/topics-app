import type { Database } from "bun:sqlite";
import {
  GLOBAL_WORKFLOW_SCOPE,
  STAGE_CI,
  isWorkflowPresetId,
  parsePersonPaths,
  resolveWorkflow,
  resolveWorkflowRules,
  type BoardWorkflow,
  type PersonPath,
  type WorkflowPresetId,
  type WorkflowRules,
  type WorkflowRulesRow,
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
 * The `board_workflow_rules` table (migration 20261114120000): the CI switch
 * and the board's paths a person must look at. Like the presets, a database
 * without the table reads as no row, and no row is the default (CI phase on,
 * generic paths only).
 */
export function readOwnWorkflowRules(db: Database, scope: string): WorkflowRulesRow | null {
  try {
    const r = db.prepare("SELECT ci_phase, person_paths FROM board_workflow_rules WHERE scope = ?").get(scope) as { ci_phase: number | null; person_paths: string | null } | null;
    if (!r) return null;
    let personPaths: PersonPath[] | null = null;
    if (r.person_paths) {
      try { personPaths = parsePersonPaths(JSON.parse(r.person_paths)); } catch { personPaths = null; }
      // A stored list that no longer reads is not "no paths": that would let the board's
      // interface land alone. It fails the read, and the land asks a person.
      if (personPaths === null) throw new Error(`board_workflow_rules: unreadable person_paths for ${scope}`);
    }
    return { ciPhase: r.ci_phase === null ? null : r.ci_phase === 1, personPaths };
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
    ciPhase: patch.ciPhase !== undefined ? patch.ciPhase : cur.ciPhase ?? null,
    personPaths: patch.personPaths !== undefined ? patch.personPaths : cur.personPaths ?? null,
  };
  if (next.ciPhase == null && (next.personPaths == null || next.personPaths.length === 0)) {
    db.prepare("DELETE FROM board_workflow_rules WHERE scope = ?").run(scope);
    return;
  }
  db.prepare(
    `INSERT INTO board_workflow_rules (scope, ci_phase, person_paths, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET ci_phase = excluded.ci_phase, person_paths = excluded.person_paths, updated_at = excluded.updated_at`,
  ).run(scope, next.ciPhase == null ? null : next.ciPhase ? 1 : 0, next.personPaths?.length ? JSON.stringify(parsePersonPaths(next.personPaths)) : null, nowIso);
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
 * A card moved to another board: its stage belongs to the source board's
 * workflow. One the target does not have (or that disagrees with the status
 * there) goes back to the default column of the status, as
 * `clearStagesOutsideWorkflow` does when a board changes preset, so a stage
 * left by an older workflow never hides a card from the tray and the
 * waiting-on-you list, which read the stage.
 */
export function dropStageOutsideTarget(db: Database, taskId: string, targetProjectId: string): void {
  const r = db.prepare("SELECT stage, status FROM tasks WHERE id = ?").get(taskId) as { stage: string | null; status: string } | null;
  if (!r?.stage) return;
  if (readBoardWorkflow(db, targetProjectId).columns.some((c) => c.id === r.stage && c.base === r.status)) return;
  db.prepare("UPDATE tasks SET stage = NULL WHERE id = ?").run(taskId);
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
