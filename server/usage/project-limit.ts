/**
 * A PROJECT'S 24H LIMIT in quota points (project quota).
 *
 * One row per project that ever had its limit chosen from the project menu.
 * A project with no row reads as the DEFAULT, decided in resolveProjectLimit
 * below (it cannot live in a column default that an absent row never sees).
 * A row with a `null` limit is the person's own choice of "no limit".
 *
 * This only STORES and reads the number. Nothing here pauses anything.
 */
import type { Database } from "bun:sqlite";

/**
 * THE one place that turns "what is stored for a project" into the limit the
 * pause gate, the meter and the menu all use. `stored` is the row's column,
 * or `undefined` when the project has no row. `null` = no limit. The way the
 * limit is computed (per project, share of the day's quota) changes only here.
 */
export function resolveProjectLimit(_projectId: string, stored: number | null | undefined): number | null {
  // TODO(64b1f052): until the day-quota percentage formula of that card lands,
  // a project with no row has NO limit (null). A fixed default of points would
  // pause projects that are already far above it the moment this ships. The
  // default for rowless projects is changed here and only here.
  return stored === undefined ? null : stored;
}

/** The limit a project has: its row's value, or the default when it has no row. `null` = no limit. */
export function readProjectLimit(db: Database, projectId: string): number | null {
  const row = db.query("SELECT limit_24h_pct FROM project_quota WHERE project_id = ?").get(projectId) as { limit_24h_pct: number | null } | null;
  return resolveProjectLimit(projectId, row ? row.limit_24h_pct : undefined);
}

/** Every configured limit by project id; a project missing from the map has the default. */
export function readProjectLimits(db: Database): Map<string, number | null> {
  const rows = db.query("SELECT project_id, limit_24h_pct FROM project_quota").all() as Array<{ project_id: string; limit_24h_pct: number | null }>;
  return new Map(rows.map((r) => [r.project_id, r.limit_24h_pct]));
}

/** The limit written from the project's menu. `null` = no limit. */
export function setProjectLimit(db: Database, projectId: string, limit24hPct: number | null): void {
  db.run(
    `INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET limit_24h_pct = excluded.limit_24h_pct, updated_at = excluded.updated_at`,
    [projectId, limit24hPct, new Date().toISOString()],
  );
}
