/**
 * THE PERIODIC OPENER (limiti-consumo-progetto, USAGE-29): the only place that
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
import { openPauseIfNeeded } from "./project-pause";

export interface ProjectQuotaSweepDeps {
  /** Injected for tests; defaults to the real `projectQuota`. */
  computeQuota?: (db: Database, opts: ProjectQuotaOptions) => ReturnType<typeof projectQuota>;
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
  for (const row of result.projects) {
    if (!row.projectId) continue; // "outside projects": nothing to pause
    try {
      if (openPauseIfNeeded(db, row.projectId, row.points24h, now)) {
        deps.onPauseOpened?.(row.projectId, row.points24h, row.projectPath);
      }
    } catch (err) {
      log(`[project-quota] pause check failed for ${row.projectId}: ${(err as Error).message}`);
    }
  }
}
