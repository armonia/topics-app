/**
 * THE WAKE OF A CARD (rule P4): back in the queue, with the wake as its note.
 *
 * The card was parked on the wait itself (`deferForWait` with `mailWaitId`:
 * `wait_reason` is `mail-wait:<id>`). Waking is conditional on that: a card
 * that is no longer parked on THIS wait (already woken, claimed, moved by a
 * person) gets nothing, so the same wake sent twice opens one turn. The note
 * goes first and is `once`, so a repeat after a stop between the two writes
 * does not double it.
 */
import type { Database } from "bun:sqlite";
import type { TaskService } from "../../services/tasks";
import type { MailWait } from "./store";

export const MAIL_WAIT_REASON_PREFIX = "mail-wait:";

export interface CardRequeued { taskId: string; projectId: string | null }

export function wakeCardFromWait(
  db: Database, svc: Pick<TaskService, "addComment">, wait: MailWait, now: Date,
): { requeued: CardRequeued | null } {
  const reason = `${MAIL_WAIT_REASON_PREFIX}${wait.id}`;
  const row = db.query("SELECT status, wait_reason, project_id FROM tasks WHERE id = ?").get(wait.ownerId) as { status: string; wait_reason: string | null; project_id: string | null } | null;
  if (!row || row.status !== "todo" || row.wait_reason !== reason) return { requeued: null };
  svc.addComment({ taskId: wait.ownerId, author: "system", kind: "service", content: wait.wakeText ?? "", once: true });
  const res = db.prepare(
    `UPDATE tasks SET dispatch_deferred_until = NULL, dispatch_state = 'queued', dispatch_error = NULL, wait_reason = NULL, wait_streak = 0,
        wait_since = NULL, updated_at = ?
      WHERE id = ? AND status = 'todo' AND wait_reason = ?`,
  ).run(now.toISOString(), wait.ownerId, reason);
  return { requeued: res.changes === 1 ? { taskId: wait.ownerId, projectId: row.project_id } : null };
}
