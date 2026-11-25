/**
 * THE PERIODIC OPENER (project quota limits, USAGE-29): the only place that
 * ever computes live quota points and decides to OPEN a pause. Every per-tick
 * gate (the dispatcher, `spawn_agent`) reads the materialized result instead
 * (`project-pause.ts:projectIsPaused`, one indexed row) — never this sweep's
 * own cost, which is a transcript scan across every project.
 *
 * A pause already open is left alone (`openPauseIfNeeded` is itself
 * idempotent): this sweep's only job is to catch the moment a project FIRST
 * crosses its limit, or crosses it again past a "Continua" ceiling, and fire
 * the one-per-pause alert through `onPauseOpened`.
 */
import type { Database } from "bun:sqlite";
import { projectQuota, type ProjectQuotaOptions } from "../usage/project-quota";
import { projectIsPaused, reconcilePause } from "./project-pause";

/**
 * Points a project had when its pause opened, kept in process memory on
 * purpose: it only feeds a log line (a MEASUREMENT of how much turns already
 * in flight keep burning, not a brake), so a restart simply starts the count
 * from the first sweep that sees the pause.
 */
const pointsAtOpen = new Map<string, number>();

/** @internal Test seam. */
export function resetPausePointsForTests(): void { pointsAtOpen.clear(); }

export interface ProjectQuotaSweepDeps {
  /** Injected for tests; defaults to the real `projectQuota`. */
  computeQuota?: (db: Database, opts: ProjectQuotaOptions) => ReturnType<typeof projectQuota>;
  /** Fired once, the instant a pause closes (window back under the limit, limit raised or removed, hold over). */
  onPauseClosed?: (projectId: string, points24h: number | null, projectPath: string | null) => void;
  /** Fired once, the instant a pause opens — the hook the outside-the-app alert (USAGE-30) hangs off. */
  onPauseOpened?: (projectId: string, points24h: number | null, projectPath: string | null) => void;
  log?: (message: string) => void;
}

/** One sweep: never throws — a failed read or write skips this round, the next one tries again. */
export function runProjectQuotaPauseSweep(db: Database, deps: ProjectQuotaSweepDeps = {}, now: number = Date.now()): void {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const compute = deps.computeQuota ?? projectQuota;
  let result: ReturnType<typeof projectQuota>;
  try {
    result = compute(db, { now });
  } catch (err) {
    log(`[project-quota] sweep skipped: ${(err as Error).message}`);
    return;
  }
  const seen = new Set<string>();
  for (const row of result.projects) {
    if (!row.projectId) continue; // "outside projects": nothing to pause
    try {
      seen.add(row.projectId);
      const t = reconcilePause(db, row.projectId, row.points24h, now);
      if (t === "opened") deps.onPauseOpened?.(row.projectId, row.points24h, row.projectPath);
      else if (t === "closed") deps.onPauseClosed?.(row.projectId, row.points24h, row.projectPath);
      logBurnedSincePause(db, row.projectId, row.points24h, t, log);
    } catch (err) {
      log(`[project-quota] pause check failed for ${row.projectId}: ${(err as Error).message}`);
    }
  }
  // A paused project with no points at all in the window has no row in the
  // reading: it still has to be able to close.
  try {
    const stale = db.query("SELECT project_id FROM project_quota WHERE paused_at IS NOT NULL").all() as Array<{ project_id: string }>;
    for (const { project_id } of stale) {
      if (seen.has(project_id)) continue;
      const t = reconcilePause(db, project_id, 0, now);
      if (t === "closed") deps.onPauseClosed?.(project_id, 0, null);
      logBurnedSincePause(db, project_id, 0, t, log);
    }
  } catch (err) {
    log(`[project-quota] stale pause check failed: ${(err as Error).message}`);
  }
}

/**
 * One log line per paused project: the points burned AFTER the pause opened
 * (current minus the points at opening). Shows whether turns already running
 * when the brake closed still weigh on the quota.
 */
function logBurnedSincePause(db: Database, projectId: string, points24h: number | null, t: "opened" | "closed" | null, log: (m: string) => void): void {
  if (t === "closed" || points24h === null || !projectIsPaused(db, projectId)) { pointsAtOpen.delete(projectId); return; }
  if (t === "opened" || !pointsAtOpen.has(projectId)) pointsAtOpen.set(projectId, points24h);
  const burned = points24h - pointsAtOpen.get(projectId)!;
  log(`[project-quota] paused ${projectId}: ${burned.toFixed(2)} points burned since the pause opened (now ${points24h.toFixed(2)})`);
}
