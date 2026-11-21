/**
 * THE PROJECT'S QUOTA BRAKE (project quota limits, USAGE-29/30).
 *
 * A project pauses when its last-24h points (`server/usage/project-quota.ts`)
 * go past its limit — 10 by default, with no configuration at all. Pausing is
 * a STATE, not an event: `project_quota.paused_at` is set once, read from
 * everywhere (dispatcher, `spawn_agent`, the goal nudge, every UI surface),
 * and cleared by one of the two confirmations:
 *
 *  - "Continua" raises a ceiling (`continued_until_pct = points + 10`) rather
 *    than clearing the limit: the project is allowed ten more points, then
 *    the confirmation comes back on its own — nobody has to remember to ask
 *    again.
 *  - "Pausa fino a domani" (`hold_until` = next local midnight) pauses
 *    REGARDLESS of points, even if they drop back under the limit, because a
 *    person who chose to stop for the day should not be re-opened by a
 *    cheaper hour.
 *
 * FAIL OPEN, same contract as `task-dispatcher-spend-cap.ts`: a quota reading
 * this module cannot trust (`null`) never blocks anything. Erring towards the
 * block stops good work over a measurement error.
 *
 * `points24h` is INJECTED rather than imported from `project-quota.ts`
 * directly: this module takes a number and a row, and gives back a reason or
 * a null, the same split the spend brake already drew. Nothing here needs to
 * know how a point is computed.
 */
import type { Database } from "bun:sqlite";

import { DEFAULT_QUOTA_LIMIT } from "../../shared/usage-shapes";

export const DEFAULT_LIMIT_24H_PCT = DEFAULT_QUOTA_LIMIT;
/** How many more points "Continua" buys before the confirmation returns. */
export const CONTINUE_GRACE_PCT = 10;

export interface ProjectQuotaRow {
  projectId: string;
  limit24hPct: number | null;
  pausedAt: string | null;
  continuedUntilPct: number | null;
  holdUntil: number | null;
}

/** The configured limit: an absent row is the default; a row with `limit24hPct: null` has no limit ("None"). */
export function effectiveLimit(row: ProjectQuotaRow | null): number | null {
  return row ? row.limit24hPct : DEFAULT_LIMIT_24H_PCT;
}

export interface ProjectPauseState {
  paused: boolean;
  /** Why, for the card/strip text; null when not paused or when the reading could not be trusted. */
  reason: "limit" | "hold-until-tomorrow" | null;
}

/**
 * Whether a project is paused right now, from its row and its last-24h
 * points. `points24h: null` (no quota history, a read that failed) always
 * answers `{ paused: false, reason: null }` — fail open.
 */
export function pauseState(row: ProjectQuotaRow | null, points24h: number | null, nowMs: number = Date.now()): ProjectPauseState {
  if (row?.holdUntil != null && nowMs < row.holdUntil) return { paused: true, reason: "hold-until-tomorrow" };
  if (points24h === null) return { paused: false, reason: null };
  const limit = effectiveLimit(row);
  if (limit === null) return { paused: false, reason: null };
  if (points24h <= limit) return { paused: false, reason: null };
  // Over the limit: a still-open "Continua" ceiling covers it.
  if (row?.continuedUntilPct != null && points24h < row.continuedUntilPct) return { paused: false, reason: null };
  return { paused: true, reason: "limit" };
}

/**
 * The cheap check every per-tick gate shares (dispatcher, `spawn_agent`, the
 * goal nudge): reads the row's OWN materialized `pausedAt`/`holdUntil`, set by
 * the periodic opener (`openPauseIfNeeded`, run every 5 minutes at boot) —
 * never recomputes live quota points on this path, so a card claim or a
 * `spawn_agent` call costs one indexed row read, not a transcript scan.
 */
export function isPausedNow(row: ProjectQuotaRow | null, nowMs: number = Date.now()): boolean {
  // A hold ("Pausa fino a domani") ends at its own midnight, whatever the
  // sweep has or has not got round to yet; the sweep then reopens the pause
  // if the project is still over its limit.
  if (row?.holdUntil != null) return nowMs < row.holdUntil;
  return !!row?.pausedAt;
}

/** Fail-open wrapper of `isPausedNow` straight from the DB, for a gate that only has a project id. */
export function projectIsPaused(db: Database, projectId: string | null, nowMs: number = Date.now()): boolean {
  if (!projectId) return false;
  try { return isPausedNow(readProjectQuotaRow(db, projectId), nowMs); } catch { return false; }
}

function nowIso(): string { return new Date().toISOString(); }

/** Local midnight strictly after `nowMs`. */
export function nextLocalMidnight(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function readProjectQuotaRow(db: Database, projectId: string): ProjectQuotaRow | null {
  const r = db.query(
    "SELECT project_id, limit_24h_pct, paused_at, continued_until_pct, hold_until FROM project_quota WHERE project_id = ?",
  ).get(projectId) as { project_id: string; limit_24h_pct: number | null; paused_at: string | null; continued_until_pct: number | null; hold_until: number | null } | null;
  if (!r) return null;
  return { projectId: r.project_id, limit24hPct: r.limit_24h_pct, pausedAt: r.paused_at, continuedUntilPct: r.continued_until_pct, holdUntil: r.hold_until };
}

function upsert(db: Database, projectId: string, patch: Partial<Omit<ProjectQuotaRow, "projectId">>): void {
  const row = readProjectQuotaRow(db, projectId);
  // A row born here (pause/continue writes one before any person ever opened
  // the project's menu) has to carry the DEFAULT limit explicitly: once the
  // row exists, `effectiveLimit` reads a null column as "None", and that
  // meaning belongs to a person's choice alone, never to a row the brake
  // created for itself.
  const next: Omit<ProjectQuotaRow, "projectId"> = {
    limit24hPct: patch.limit24hPct !== undefined ? patch.limit24hPct : row ? row.limit24hPct : DEFAULT_LIMIT_24H_PCT,
    pausedAt: patch.pausedAt !== undefined ? patch.pausedAt : row?.pausedAt ?? null,
    continuedUntilPct: patch.continuedUntilPct !== undefined ? patch.continuedUntilPct : row?.continuedUntilPct ?? null,
    holdUntil: patch.holdUntil !== undefined ? patch.holdUntil : row?.holdUntil ?? null,
  };
  db.run(
    `INSERT INTO project_quota (project_id, limit_24h_pct, paused_at, continued_until_pct, hold_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET limit_24h_pct = excluded.limit_24h_pct, paused_at = excluded.paused_at,
       continued_until_pct = excluded.continued_until_pct, hold_until = excluded.hold_until, updated_at = excluded.updated_at`,
    [projectId, next.limit24hPct, next.pausedAt, next.continuedUntilPct, next.holdUntil, nowIso()],
  );
}

/** The project's chosen limit, written from its menu. `null` = "None" (no limit). */
export function setProjectLimit(db: Database, projectId: string, limit24hPct: number | null): void {
  upsert(db, projectId, { limit24hPct });
}

/**
 * Opens the pause if it is not already open: sets `pausedAt` once, so a
 * caller that fires an alert "once per pause" can read the PREVIOUS row and
 * tell a fresh pause from one already showing everywhere.
 *
 * Returns `true` the one time it actually opened the pause (the alert should
 * fire), `false` when it was already paused or there is nothing to open.
 */
export function openPauseIfNeeded(db: Database, projectId: string, points24h: number | null, nowMs: number = Date.now()): boolean {
  const row = readProjectQuotaRow(db, projectId);
  if (row?.pausedAt) return false; // already open
  const state = pauseState(row, points24h, nowMs);
  if (!state.paused) return false;
  upsert(db, projectId, { pausedAt: nowIso() });
  return true;
}

export type PauseTransition = "opened" | "closed" | null;

/**
 * Brings the materialized pause in line with the live points, in BOTH
 * directions: opens it when the project crossed its limit, closes it when the
 * window fell back under the limit, the limit was raised or removed, or a hold
 * ran out its midnight. The one writer of `pausedAt` besides the two
 * confirmations. Returns what changed so the caller can broadcast.
 */
export function reconcilePause(db: Database, projectId: string, points24h: number | null, nowMs: number = Date.now()): PauseTransition {
  const row = readProjectQuotaRow(db, projectId);
  if (!row?.pausedAt) return openPauseIfNeeded(db, projectId, points24h, nowMs) ? "opened" : null;
  if (row.holdUntil != null && nowMs < row.holdUntil) return null; // a person's hold wins over points
  if (row.holdUntil != null) upsert(db, projectId, { holdUntil: null }); // the hold is over
  if (points24h === null) return null; // an unreadable measurement keeps what is there
  if (pauseState({ ...row, holdUntil: null }, points24h, nowMs).paused) return null;
  upsert(db, projectId, { pausedAt: null });
  return "closed";
}

/** "Continua": unblocks everywhere for `CONTINUE_GRACE_PCT` more points. */
export function continueProject(db: Database, projectId: string, points24h: number | null): void {
  const current = points24h ?? 0;
  upsert(db, projectId, { pausedAt: null, holdUntil: null, continuedUntilPct: current + CONTINUE_GRACE_PCT });
}

/** "Pausa fino a domani": paused regardless of points until local midnight. */
export function pauseUntilTomorrow(db: Database, projectId: string, nowMs: number = Date.now()): void {
  upsert(db, projectId, { pausedAt: nowIso(), holdUntil: nextLocalMidnight(nowMs), continuedUntilPct: null });
}

export interface ProjectPauseInfo extends ProjectPauseState {
  projectId: string;
  limit: number | null;
  points24h: number | null;
}

/** The one read every gate (dispatcher, `spawn_agent`, goal nudge) and every UI surface shares. Fail open on any error. */
export function projectPauseInfo(db: Database, projectId: string, points24h: number | null, nowMs: number = Date.now()): ProjectPauseInfo {
  try {
    const row = readProjectQuotaRow(db, projectId);
    return { projectId, limit: effectiveLimit(row), points24h, ...pauseState(row, points24h, nowMs) };
  } catch {
    return { projectId, limit: null, points24h: null, paused: false, reason: null };
  }
}
