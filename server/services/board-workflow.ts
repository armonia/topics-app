import type { Database } from "bun:sqlite";
import {
  GLOBAL_WORKFLOW_SCOPE,
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
