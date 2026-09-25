/**
 * THE LINE UNDER A TURN THE MACHINE STOPPED BEFORE IT SAID ANYTHING (card
 * 46617a7f).
 *
 * A land (`superseded`), a delegation's deadline (`wall-clock`) and the stall
 * judge (`stall`) stop a turn on purpose (lib/abort-cause.ts). When that turn
 * had produced nothing, its row is discarded, as every empty stop is, and the
 * chat ends on the message the turn was answering: for a card, the
 * dispatcher's envelope. The client reads that shape as a reply that never came
 * (`turnLooksUnanswered`) and offers its Retry button, which resends the envelope: a
 * paid turn to redo work that is already on main, or that the dispatcher is
 * about to continue on its own. Measured on the production DB before this fix:
 * 11 card chats ending on an envelope, each card landed about a second later.
 *
 * The fact that the machine stopped the turn has to travel WITH the rows, or a
 * reload loses it. So the chat gets one assistant row that carries only a
 * `machine-stop` block, drawn by the client as a service line, and the chat no
 * longer ends on an unanswered message.
 *
 * -- Only on a chat the board drives -------------------------------------------
 * A land and a delegation's deadline only ever stop a card's chat. The stall
 * judge also recycles a person's own chat (a turn adopted at boot), and there
 * nothing continues by itself: the resume sweep resends the person's question,
 * and until then Retry is theirs to press. A service row there would silence
 * both (third review of this fix), so a chat no card or attempt drives keeps
 * the behaviour it had.
 *
 * -- Why `content` stays empty ------------------------------------------------
 * Every reader that must not see this row reads `content` alone: the model's
 * history (`context/assemble.ts`, the claude-code replay, the native rehydrate
 * all drop an empty `content`) and the dispatcher's "last words of the agent"
 * (`getLastAgentText` in server.ts, which skips an empty `content`). A sentence
 * there would be quoted on the card as the agent's report, and on a
 * delegation's deadline it would turn a card that produced nothing into a
 * delivery (`recoverAgentWords`). The block is what keeps the row: a non-text
 * block is work for `isEmptyAssistantTurn`, so no later pass discards it.
 */
import type { AppContext, ContentBlock } from "../types";
import { machineStopToolError, type MachineStopCause } from "./abort-cause";

/** The block, with the sentence a client older than it prints as prose. */
export function machineStopBlock(cause: MachineStopCause): Extract<ContentBlock, { kind: "machine-stop" }> {
  return { kind: "machine-stop", cause, text: machineStopToolError(cause) };
}

/**
 * Does a card, or one of its fan-out attempts, drive this topic? The abort
 * comes before the dispatcher releases the card (`cancelDelegatedTask`, the
 * land's `cutLiveTurn`), so the binding is still there when this runs. A
 * database without those tables is no evidence.
 */
export function boardDrivesTopic(db: { query(sql: string): { get(...args: string[]): unknown } }, topicId: string): boolean {
  try {
    return !!db.query(
      `SELECT 1 FROM tasks WHERE assigned_topic_id = ?1
       UNION ALL SELECT 1 FROM task_attempts WHERE topic_id = ?1 LIMIT 1`,
    ).get(topicId);
  } catch {
    return false;
  }
}

/**
 * Does the chat need the line? Only when the thread ends on the message the
 * stopped turn was answering, and that message is a user row.
 *
 * If the turn's row survived (it had produced something) the thread ends on
 * that row, not on its parent. If somebody wrote after the stop, the thread
 * ends on that newer row, whose own turn is not this one's business.
 */
export function needsMachineStopNotice(
  thread: ReadonlyArray<{ id: string; role: string }>,
  answeredMessageId: string | null | undefined,
): boolean {
  if (!answeredMessageId) return false;
  const last = thread.at(-1);
  return !!last && last.id === answeredMessageId && last.role === "user";
}

/**
 * Write the line and tell the screens, when the chat needs it. Called by
 * `/api/chat/abort` after both finalizes, so whichever ran first has already
 * discarded the turn's row.
 *
 * On the claude-code path the chat route has sent its own `stream:end` by now.
 * A watching window still paints no banner in between: the banner also waits
 * for the streaming registry to be read again, an HTTP round trip that starts
 * after this frame is out.
 */
export function leaveMachineStopNotice(
  deps: Pick<AppContext, "db" | "loadLocalMessages" | "appendLocalMessage" | "broadcastToAll">,
  turn: { sessionKey: string; topicId: string; cause: MachineStopCause; answeredMessageId: string },
): void {
  if (!boardDrivesTopic(deps.db, turn.topicId)) return;
  const thread = deps.loadLocalMessages(turn.sessionKey, { withBlocks: false, withToolCalls: false });
  if (!needsMachineStopNotice(thread, turn.answeredMessageId)) return;
  const block = machineStopBlock(turn.cause);
  const notice = deps.appendLocalMessage(turn.sessionKey, "assistant", "", undefined, [block]);
  // The row's `content` is empty on purpose, but the live handler drops a
  // `message:new` without text: the frame carries the sentence the client
  // falls back to, and the block is what it draws.
  deps.broadcastToAll({
    type: "message:new", topicId: turn.topicId, sessionKey: turn.sessionKey, role: "assistant",
    messageId: notice.id, content: block.text, preview: "", blocks: [block],
  });
}
