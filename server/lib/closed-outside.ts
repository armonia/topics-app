/**
 * A TURN'S ROW CLOSED BY SOMETHING OTHER THAN THE TURN (card a57e6d4d).
 *
 * Two closers work outside the chat route: the stale-stream sweeper, which
 * gives up on a turn gone silent, and the end of a reattach leg after a
 * restart. Both write `end_reason = 'closed-outside'`. That is what
 * `send_chat_message` reports as "closed from outside" and what the next
 * reattach adopts, even on a row that kept the latency of an earlier leg: the
 * latency alone called such a row a finished reply.
 *
 * The reopen after a leg that ends on a turn still open is here too, since it
 * decides which row the next reattach takes back, and so is the frame that
 * tells the open windows a leg closed rows under them.
 */
import type { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import type { ContentBlock, TurnEndCause } from "../../shared/types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import type { AIProvider } from "../providers/types";
import { threadChangedFrame } from "./boot-partial-sweep";
import { timelineWithInterruptedVerdict } from "./interrupted-turn-block";
import { spiegaTurnoTroncato } from "./turno-troncato";
import { answeredBeforeRow } from "./answered-before";
import { INTERRUPTED_MARKER, INTERRUPTED_NO_RESUME_MARKER } from "./stale-stream-sweep";

/**
 * The stale-stream sweeper's `finalizeMessage` (`lib/stale-stream-sweep.ts`).
 *
 * Its sentence promises the resume sweep's resend, which a later turn under a
 * message already answered never gets (`answeredBeforeRow`): on such a row the
 * same cut is said without the promise, in the text and in the verdict.
 */
export function finalizeStaleRow(
  db: Database,
  args: { messageId: string; marker: string | null; interruption: { text: string; cause: TurnEndCause; at: string } },
): void {
  const { messageId } = args;
  let { marker, interruption } = args;
  const sessionKey = () => (db.query("SELECT session_key FROM messages WHERE id = ?").get(messageId) as { session_key?: string } | null)?.session_key;
  if (interruption.text === INTERRUPTED_MARKER && answeredBeforeRow(db, sessionKey() ?? "", messageId)) {
    if (marker === INTERRUPTED_MARKER) marker = INTERRUPTED_NO_RESUME_MARKER;
    interruption = { ...interruption, text: INTERRUPTED_NO_RESUME_MARKER };
  }
  if (marker === null) db.run("UPDATE messages SET partial = 0, streamed_at = NULL, end_reason = 'closed-outside' WHERE id = ?", [messageId]);
  else db.run("UPDATE messages SET partial = 0, streamed_at = NULL, end_reason = 'closed-outside', content = ? WHERE id = ?", [marker, messageId]);
  // WHY the turn ended, on the row, in the shape the composer's banner reads.
  // Without it the reaper closed a turn cut mid-answer leaving the reason in
  // the server log only: the 2026-09-03 report, "stuck with no feedback at
  // all". `timelineWithInterruptedVerdict` refuses the rows that must not be
  // touched (empty timeline, already explained).
  try {
    const row = db.query("SELECT blocks FROM messages WHERE id = ?").get(messageId) as { blocks?: unknown } | undefined;
    const raw = decodeCol(row?.blocks);
    const parsed = raw ? (JSON.parse(raw) as ContentBlock[]) : null;
    const timeline = timelineWithInterruptedVerdict(parsed, interruption);
    if (timeline) db.run("UPDATE messages SET blocks = ? WHERE id = ?", [encodeCol(JSON.stringify(timeline)) ?? null, messageId]);
  } catch (err) {
    // A row we cannot read is a row we leave alone: the marker above already
    // said something, and rewriting a timeline we failed to parse would throw
    // away the turn for not understanding it.
    console.warn(`[StaleStream] verdict not written on ${messageId}:`, err);
  }
}

/**
 * A reattach leg ended on a turn the broker still calls open (a question on
 * screen): the leg's row is lit again, for the next reattach to take back, and
 * its `done` goes with it, since an open row has not ended. The leg's row is
 * the last one a turn finalized, not a report written whole after it (`done`
 * with no latency): lighting that one handed it to the next reattach, or to
 * the boot sweep's "cut".
 */
export function relightReattachedRow(db: Database, sessionKey: string): void {
  db.run(
    `UPDATE messages SET partial = 1, end_reason = NULL WHERE id = (
       SELECT id FROM messages WHERE session_key = ? AND role = 'assistant'
         AND (COALESCE(end_reason, '') <> 'done' OR latency_ms IS NOT NULL)
       ORDER BY sort_order DESC LIMIT 1)`,
    [sessionKey],
  );
}

/** What the end of a reattach leg needs from the server's context. */
interface ReattachLegContext {
  db: Database;
  getTopicBySessionKey(sessionKey: string): { id: string } | null | undefined;
  /** Filters guests: the frame names a topic a guest may not be granted. */
  broadcastToAll(msg: OutboundMessage): void;
}

/**
 * The end of a reattach leg (`reattachSurvivingChatTurns` in server.ts): the
 * leg is over, the TURN may not be, so the broker is asked first. `broker` is
 * the claude-code provider, absent when it is not up. Never throws: it runs in
 * the `.finally` of a promise nobody awaits.
 *
 * Open: the leg's row is written open again (`relightReattachedRow`). The
 * leg's finalize has already turned `partial` off, and a turn parked on
 * `ask_user_question` stays open for hours: left closed, every restart opened a
 * new row for the same turn (nine rows for one on topic:9fe7a291, 2026-08-18;
 * five copies on topic:ed2070df). Nothing is sent: the windows are watching
 * that turn.
 *
 * Anything else, a broker that does not answer included: whatever is still
 * open is closed from outside, and a turn the restart killed mid-tool gets its
 * notice (`spiegaTurnoTroncato`). Closed in silence, it looked like a finished
 * answer: the two chats of 20/08. Rows closed are announced
 * (`threadChangedFrame`): written in the database only, the open windows kept
 * the bubble open and unexplained until a reload (card edf3c4db). Nothing
 * closed, nothing sent.
 */
export async function endReattachLeg(
  ctx: ReattachLegContext,
  sessionKey: string,
  broker: Pick<AIProvider, "brokerTurnState"> | undefined,
): Promise<{ relit: boolean; closed: number }> {
  let brokerSays: "open" | "idle" | "unknown" = "unknown";
  try { brokerSays = (await broker?.brokerTurnState?.(sessionKey)) ?? "unknown"; } catch { /* no answer: closed, as before */ }
  if (brokerSays === "open") {
    try { relightReattachedRow(ctx.db, sessionKey); } catch { /* at worst the next reattach opens a new row, as before */ }
    console.log(`[chat-reattach] ${sessionKey}: the leg is over but the turn is still open (a question on screen), its row stays live`);
    return { relit: true, closed: 0 };
  }
  let closed = 0;
  try {
    closed = ctx.db.run("UPDATE messages SET partial = 0, streamed_at = NULL, end_reason = 'closed-outside' WHERE session_key = ? AND partial = 1", [sessionKey]).changes;
    if (closed > 0) {
      spiegaTurnoTroncato(ctx.db, sessionKey);
      const topic = ctx.getTopicBySessionKey(sessionKey);
      if (topic) ctx.broadcastToAll(threadChangedFrame(topic, sessionKey));
    }
  } catch { /* the next boot's reset catches it */ }
  return { relit: false, closed };
}
