/**
 * THE DELIVERY THAT MUST OUTLIVE THE PROCESS THAT ANSWERED IT 202.
 *
 * `pendingDeliveries` (routes/tasks.ts) is the PATCH the route answered "the
 * checks are still running" to, kept so the server can re-issue it to itself
 * when the round ends and the client has stopped polling. It was a `Map`, so a
 * reload forgot it, and that was almost harmless while a card turn held every
 * reload back: the round died with the server and the agent's next leg opened
 * the delivery again.
 *
 * It stopped being harmless on 2026-09-15, when a delivery whose round is only
 * WAITING stopped holding the restart (`cardTurnsHoldingReload`): that cut is
 * only free if the delivery comes back by itself. And "comes back" has to mean
 * the SAME delivery — same body, same commit — or the restarted round realigns
 * the branch on main a second time, which is a second merge commit in the
 * worktree for a delivery nobody re-made.
 *
 * So the row is written the moment the route answers 202, and removed the
 * moment a verdict is recorded (or the card moves on). Rows are read once, at
 * boot; from there on the in-memory map is the fast path, exactly as before.
 *
 * Best-effort by construction: every call swallows its own error. A database
 * that cannot write this row must not refuse a delivery - the cost of losing it
 * is one extra realign after a restart, the cost of throwing here is a card
 * that cannot deliver at all.
 */
import type { Database } from "bun:sqlite";

export interface PendingDelivery {
  taskId: string;
  /** The path the PATCH arrived on: the re-issue goes back through the same door. */
  pathname: string;
  /** The body as the agent sent it (summary included), minus the leg length. */
  body: Record<string, unknown>;
  /** The commit the round was measuring, or null when it never got that far. */
  commit: string | null;
}

type Row = { task_id: string; pathname: string; body_json: string; commit_sha: string | null };

export function savePendingDelivery(db: Database, entry: PendingDelivery): void {
  try {
    db.prepare(
      `INSERT INTO pending_deliveries (task_id, pathname, body_json, commit_sha, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(task_id) DO UPDATE SET
         pathname = excluded.pathname,
         body_json = excluded.body_json,
         -- A commit read later in the round is the one that counts; a leg that
         -- arrives before the checkout is known must not erase it with NULL.
         commit_sha = COALESCE(excluded.commit_sha, pending_deliveries.commit_sha)`,
    ).run(entry.taskId, entry.pathname, JSON.stringify(entry.body), entry.commit);
  } catch { /* see the docstring: losing the row costs a realign, throwing costs the delivery */ }
}

export function forgetPendingDelivery(db: Database, taskId: string): void {
  try { db.prepare("DELETE FROM pending_deliveries WHERE task_id = ?").run(taskId); }
  catch { /* best-effort */ }
}

/** Every delivery a previous process was still waiting on. Unparsable rows are
 *  dropped rather than thrown: one broken row must not stop the other cards. */
export function loadPendingDeliveries(db: Database): PendingDelivery[] {
  let rows: Row[] = [];
  try { rows = db.prepare("SELECT task_id, pathname, body_json, commit_sha FROM pending_deliveries").all() as Row[]; }
  catch { return []; }
  const out: PendingDelivery[] = [];
  for (const row of rows) {
    let body: unknown;
    try { body = JSON.parse(row.body_json); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      forgetPendingDelivery(db, row.task_id);
      continue;
    }
    out.push({
      taskId: row.task_id,
      pathname: row.pathname,
      body: body as Record<string, unknown>,
      commit: row.commit_sha ?? null,
    });
  }
  return out;
}
