/**
 * `owed_answers`: the index of the answers still owed to the model
 * (migration 20260930131539-owed-answers.sql, `lib/answer-relay.ts`).
 *
 * The `queued` mark lives inside the row's compressed tool calls, where only a
 * walk of the rows finds it, and the boot's walk covers thirty days of
 * finalized rows of topics not archived. A question never expires, so the
 * boot reads the owed answers from here instead: one entry per `queued` mark,
 * written in the same transaction as the mark, deleted in the same
 * transaction as the `sent` one. What the boot pays follows what is owed.
 */
import type { Database } from "bun:sqlite";
import { decodeCol } from "../../shared/message-blob";
import { owedAnswerOf, type OwedAnswer } from "./answer-relay";
import { storedToolCall } from "./question-outlives-asker";

/** The answer to this tool call is owed: its row now says `queued`. */
export function markAnswerOwed(
  db: Database,
  owed: { toolCallId: string; sessionKey: string; rowId: string },
  createdAt = Date.now(),
): void {
  // A second answer to the same panel keeps the first one's place in the order.
  db.prepare(
    `INSERT INTO owed_answers (tool_call_id, session_key, row_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(tool_call_id) DO UPDATE SET session_key = excluded.session_key, row_id = excluded.row_id`,
  ).run(owed.toolCallId, owed.sessionKey, owed.rowId, createdAt);
}

/** The answer to this tool call is no longer owed: its row says `sent`. */
export function markAnswerNotOwed(db: Database, toolCallId: string): void {
  db.prepare(`DELETE FROM owed_answers WHERE tool_call_id = ?`).run(toolCallId);
}

/**
 * Every answer the index says is owed, rebuilt from its row (`owedAnswerOf`),
 * oldest first. Any age, any topic, archived or not, partial row or not. An
 * entry whose row is gone, or whose row no longer says `queued` (a chat
 * cleared, a mark overwritten), is dropped: nothing is owed there any more.
 */
export function loadOwedAnswers(db: Database): OwedAnswer[] {
  const entries = db.prepare(
    `SELECT o.tool_call_id, o.session_key, o.row_id, m.tool_calls, m.blocks
       FROM owed_answers o LEFT JOIN messages m ON m.id = o.row_id
      ORDER BY o.created_at, o.rowid`,
  ).all() as Array<{ tool_call_id: string; session_key: string; row_id: string; tool_calls: unknown; blocks: unknown }>;
  const owed: OwedAnswer[] = [];
  const gone: string[] = [];
  for (const e of entries) {
    const call = storedToolCall([e], e.tool_call_id, decodeCol);
    const o = call ? owedAnswerOf(call, { sessionKey: e.session_key, rowId: e.row_id }) : null;
    if (o) owed.push(o); else gone.push(e.tool_call_id);
  }
  for (const id of gone) markAnswerNotOwed(db, id);
  if (gone.length > 0) console.log(`[boot] ${gone.length} owed answer(s) whose row no longer owes them dropped from the index`);
  return owed;
}
