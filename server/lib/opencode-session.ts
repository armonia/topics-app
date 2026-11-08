/**
 * opencode-session.ts — discover the opencode CLI's per-session id + AI-generated
 * title so a Topics terminal PTY running `opencode` can auto-name its tab, the
 * opencode analogue of codex-session.ts.
 *
 * Unlike claude (JSONL transcript + `ai-title` event) and codex (JSONL rollout,
 * titled from the user's own prompts), opencode stores everything in SQLite at
 *   ($XDG_DATA_HOME || ~/.local/share)/opencode/opencode.db
 * The `session` table already carries an AI-generated `title` column (e.g.
 * "Fix the build error", "Comando semplice"), so — unlike codex — we don't parse
 * turns: we just read the title that opencode itself computed.
 *
 * A session row appears only once the user sends their first prompt (opencode
 * mints `ses_…` then), and the AI title lands a moment later, so discovery is
 * matched by directory (== the pane's cwd) + recency, and the caller re-checks on
 * every busy→idle turn boundary + a low-frequency sweep. Read-only + best-effort:
 * a locked/missing DB just means the tab keeps its "opencode" label.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { Database } from 'bun:sqlite';

/** ($XDG_DATA_HOME || ~/.local/share)/opencode/opencode.db */
export function opencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

/** opencode seeds a new row with "New session - <ISO>" before the AI title lands;
 *  treat that (and empties) as "no real title yet" so we don't label a tab with
 *  the placeholder. */
function isPlaceholderTitle(t: string | null | undefined): boolean {
  return !t || !t.trim() || t.startsWith('New session');
}

/** Open the DB read-only for one query, then close. The DB is WAL and owned by a
 *  live opencode process; a short-lived read-only connection avoids contending
 *  its lock. Any failure (missing file, lock, schema drift) → null, never throws. */
function withDb<T>(fn: (db: Database) => T): T | null {
  const path = opencodeDbPath();
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Best-effort: the id (`ses_…`) of the opencode session most likely just used in
 * `cwd` — the newest top-level (parent_id IS NULL) session in that directory
 * created at/after the pane spawned (minus clock-skew tolerance). Null when none
 * matches (pane still non-named, retried next turn).
 */
export function discoverOpencodeSessionId(opts: {
  cwd: string;
  sinceMs: number;
  skewMs?: number;
}): string | null {
  const skewMs = opts.skewMs ?? 5000;
  return withDb((db) => {
    const row = db
      .query(
        "SELECT id FROM session WHERE directory = ? AND time_created >= ? AND parent_id IS NULL ORDER BY time_created DESC LIMIT 1",
      )
      .get(opts.cwd, opts.sinceMs - skewMs) as { id: string } | undefined;
    return row?.id ?? null;
  });
}

/**
 * The AI-generated title for `id`, or null when the row is missing or still holds
 * the "New session - …" placeholder (title not computed yet). No turn parsing —
 * opencode already wrote a human title into the `title` column.
 */
export function deriveOpencodeSessionTitle(id: string): string | null {
  if (!id) return null;
  return withDb((db) => {
    const row = db
      .query("SELECT title FROM session WHERE id = ?")
      .get(id) as { title: string } | undefined;
    if (!row || isPlaceholderTitle(row.title)) return null;
    return row.title.trim();
  });
}
