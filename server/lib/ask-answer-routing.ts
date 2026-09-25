/**
 * WHERE AN ANSWER TO A QUESTION MUST GO.
 *
 * The Topics question tool blocks inside its own handler, polling for the
 * answer: the reply travels back through the rendez-vous
 * (`ask-user-bridge.ts`), never through a provider's stdin. Sending it down
 * the provider path instead means, for a runtime that has no such path, a 503
 * on a perfectly valid answer.
 *
 * The in-memory registry cannot be the only witness. It empties on every server
 * restart while the row on disk still carries the open question, so after a
 * restart the memory says "no ask here" about a question that is plainly there.
 * The row is the durable fact; memory is only the fast path.
 */

/** One stored message, as the columns come out of SQLite. */
export interface AskHaystackRow {
  id?: string;
  tool_calls?: unknown;
  blocks?: unknown;
}

/**
 * Does one of these rows carry THIS question?
 *
 * NOT just the last row, and that is the whole point. Reading only the bottom
 * row assumes nothing was written after the question, and a single notice
 * appended underneath breaks the assumption: after a restart the last message
 * of a session is "turn interrupted", not the question. There the lookup
 * failed, the answer fell through to the provider branch, and the human read
 * `provider topics does not support user input` - a 503 on an answer that was
 * fine. Measured on 2026-08-28, topic:4c935add.
 *
 * The caller passes a short window on purpose: the question being answered
 * belongs to this exchange, not to yesterday, and a scan of the whole session
 * would cost a table walk per answer.
 */
export function rowsCarryAsk(
  rows: readonly AskHaystackRow[],
  toolCallId: string,
  decode: (value: unknown) => string | null | undefined,
): boolean {
  return rows.some((row) => {
    const haystack = `${decode(row?.tool_calls) ?? ""}${decode(row?.blocks) ?? ""}`;
    return haystack.includes(toolCallId) && haystack.includes("ask_user_question");
  });
}

/**
 * WHICH row carries this question: the answer is written on THAT row.
 *
 * Same window and same match as `rowsCarryAsk`, but the id comes back. The
 * answer route used to patch the session's LAST row, which is the question's
 * row only while nothing was written after it: a question asked by a turn the
 * watchdog had already closed sits on that turn's own row, above the sweep's
 * notice, and the answer went to the notice, which has no such tool (review of
 * card 1046df0b). Rows are expected newest first; `null` when none carries it.
 */
export function rowCarryingAsk(
  rows: readonly AskHaystackRow[],
  toolCallId: string,
  decode: (value: unknown) => string | null | undefined,
): string | null {
  const row = rows.find((r) => rowsCarryAsk([r], toolCallId, decode));
  return typeof row?.id === "string" ? row.id : null;
}

/**
 * WHICH row carries this tool call, whatever the tool: permission panels,
 * outbound confirmations and plan approvals are patched on THAT row by id.
 *
 * The same reason as `rowCarryingAsk`: "the last row" is the tool's row only
 * while nothing was written after it, and a turn closed by the watchdog keeps
 * working under the sweep's notice. Rows newest first; `null` when none of the
 * window carries the id, which the caller must treat as "not announced", never
 * as "the last row".
 */
export function rowCarryingTool(
  rows: readonly AskHaystackRow[],
  toolCallId: string,
  decode: (value: unknown) => string | null | undefined,
): string | null {
  if (!toolCallId) return null;
  const row = rows.find((r) => `${decode(r?.tool_calls) ?? ""}${decode(r?.blocks) ?? ""}`.includes(toolCallId));
  return typeof row?.id === "string" ? row.id : null;
}
