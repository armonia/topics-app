/**
 * THE CARD'S STATE, WRITTEN TO THE ATTENTION STORE BY THE TASK SERVICE
 * (notifications-redesign, T14, T15).
 *
 * A card in review or parked waits on the person: it is `needs-you` on its
 * subject `task:<id>`. The task service writes the card's status in some
 * twenty places, most of them raw SQL; rather than a call next to each, the
 * methods that can move a card are wrapped here, and after each one the card
 * is read back from its row and handed to `setCard`. The store decides the
 * epoch, the announce and the row.
 */
import type { Database } from "bun:sqlite";
import { setCard } from "./store";
import { taskSubject } from "../../shared/attention";
import { isThreadSpeech, PARKED_WAITED_OUT, pendingQuestion } from "../../shared/board";
import type { TaskService } from "../services/tasks";

/**
 * The service methods that can move a card in or out of review or its park.
 * Each is followed by the card's state written to the attention store, read
 * back from the row: the store decides the epoch, the announce and the row
 * (notifications-redesign, T14, T15). A new method that moves a card belongs
 * here, or its card keeps the state it had.
 */
const CARD_MOVING_METHODS: ReadonlyArray<keyof TaskService> = [
  "create", "update", "reviewDecision", "merge", "archive", "restore", "moveToProject", "claim", "release",
  "deferForWait", "deliverToReviewBySystem", "askParkedChildren", "sweepParkedChildren", "waitedOutIfCapped",
  "sweepWaitedOut", "resolveParkedChildren", "setDispatchState", "settleLanded",
];

/** The dispatch states of a card parked in backlog that the person must look at (they announce `task:parked`). */
const ANNOUNCED_PARK_STATES = new Set(["failed", "blocked", PARKED_WAITED_OUT]);

export function withCardAttention(db: Database, service: TaskService, commentAsksHuman: (content: string | null | undefined) => boolean): TaskService {
  // Prepared on first use: a service built on a stand-in database (route tests)
  // must not fail at construction for a write it never makes.
  const descendantsSql =
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM tasks WHERE id = ?
       UNION ALL
       SELECT t.id FROM tasks t JOIN descendants s ON t.parent_task_id = s.id
     )
     SELECT id FROM descendants`;
  const readSql = "SELECT text, project_id, status, dispatch_state, dispatch_error, archived, review_at, updated_at FROM tasks WHERE id = ?";
  /**
   * The words of the card's announce (PUSH-04): its title and project, and for
   * a review its pending question, whose options become the buttons, and
   * whether the agent's last word ASKS (`commentAsksHuman`), which picks the
   * title. Best-effort: a banner without buttons beats no banner.
   */
  function words(taskId: string, row: { text: string | null; project_id: string; dispatch_state: string | null }, review: boolean) {
    let question: unknown = null;
    let isAsk: boolean | null = null;
    if (review) {
      try {
        const comments = service.get(taskId)?.comments ?? [];
        question = pendingQuestion(comments);
        const speech = comments.filter(isThreadSpeech);
        isAsk = commentAsksHuman(speech[speech.length - 1]?.content);
      } catch { question = null; isAsk = null; }
    }
    const parkState = row.dispatch_state === "blocked" ? "blocked" : row.dispatch_state === PARKED_WAITED_OUT ? "waited_out" : "failed";
    return { name: row.text || null, projectId: row.project_id, question, isAsk, parkState };
  }
  function sync(taskId: string): void {
    try {
      const row = db.query(readSql).get(taskId) as { text: string | null; project_id: string; status: string; dispatch_state: string | null; dispatch_error: string | null; archived: number; review_at: string | null; updated_at: string } | null;
      const subject = taskSubject(taskId);
      if (!row || row.archived) { setCard(subject, null); return; }
      if (row.status === "review") { setCard(subject, { status: "review", since: row.review_at ?? row.updated_at, words: words(taskId, row, true) }); return; }
      if (row.status === "backlog" && row.dispatch_state && ANNOUNCED_PARK_STATES.has(row.dispatch_state)) {
        setCard(subject, { status: "parked", since: row.updated_at, detail: row.dispatch_error, words: words(taskId, row, false) });
        return;
      }
      setCard(subject, null);
    } catch (err) {
      console.warn(`[tasks] attention of ${taskId} failed:`, (err as Error)?.message || err);
    }
  }
  function idsOf(value: unknown, out: Set<string>): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) idsOf(v, out); return; }
    const v = value as { id?: unknown; taskId?: unknown; intoTaskId?: unknown; taskIds?: unknown; task?: unknown; children?: unknown; status?: unknown };
    if (typeof v.taskId === "string") out.add(v.taskId);
    if (typeof v.intoTaskId === "string") out.add(v.intoTaskId);
    if (Array.isArray(v.taskIds)) for (const id of v.taskIds) if (typeof id === "string") out.add(id);
    if (typeof v.id === "string" && typeof v.status === "string") out.add(v.id);
    if (v.task) idsOf(v.task, out);
    if (v.children) idsOf(v.children, out);
  }
  const target = service as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of CARD_MOVING_METHODS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      const ids = new Set<string>();
      idsOf(args[0], ids);
      idsOf(result, ids);
      // Archiving a parent archives its descendants: every card in it leaves its wait.
      if (name === "archive" || name === "merge" || name === "restore") {
        for (const id of [...ids]) { try { for (const r of db.query(descendantsSql).all(id) as Array<{ id: string }>) ids.add(r.id); } catch { /* no table to walk */ } }
      }
      for (const id of ids) sync(id);
      return result;
    };
  }
  return service;
}
