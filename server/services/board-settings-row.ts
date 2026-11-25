/**
 * A `board_settings` row as SQLite returns it: snake_case columns, booleans as
 * 0/1, and every column added by a later migration nullable. Only the columns
 * `getBoardSettings` reads are listed.
 */
import type { Database } from "bun:sqlite";

export interface BoardSettingsRow {
  dispatch_effort: string | null;
  dispatch_use_worktree: number | null;
  dispatch_auto_merge: number | null;
  deploy_command: string | null;
  dispatch_timeout_min: number | null;
  dispatch_idle_min: number | null;
  dispatch_mcp: string | null;
  dispatch_model: string | null;
  dispatch_topics_routing: number | null;
  dispatch_machine_id: string | null;
  dispatch_overflow: number | null;
  dispatch_stay_local: number | null;
  language: string | null;
  dispatch_fanout: number | null;
  dispatch_retry_cap: number | null;
  dispatch_retry_backoff_s: number | null;
  require_approval_for_done: number | null;
  require_review_before_done: number | null;
  review_checks: string | null;
  dispatch_paused: number | null;
  night_mode: number | null;
  night_mode_until: string | null;
  night_mode_started_at: string | null;
}

/** The settings row of one board, or null when it never had one. */
export function readBoardSettingsRow(db: Database, boardId: string): BoardSettingsRow | null {
  return db.prepare("SELECT * FROM board_settings WHERE project_id = ?").get(boardId) as BoardSettingsRow | null;
}
