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
 * -- Only under the machine's own envelope ------------------------------------
 * What decides is the message the stopped turn was answering, not whether a
 * card owns the chat. Under a dispatcher's envelope (the user row marked
 * `dispatched-envelope`, lib/user-row-marks.ts) a retry resends that envelope:
 * work that landed, a delegation that was revoked or ran out, a turn the
 * dispatcher continues itself. Under a question the person typed, Retry is
 * theirs and so is the resume sweep's resend, whether the chat is their own or
 * a card's in review (fourth review of this fix).
 *
 * The card binding was the first gate, and it was wrong both ways: a revoked
 * delegation releases the card (clearing `assigned_topic_id`) before the
 * abort, which the board does not await, reaches this line; and a card in
 * review keeps its binding while the person asks it something.
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

/** Is this row one of the dispatcher's envelopes? */
export function isMachineEnvelope(row: { role: string; blocks?: ContentBlock[] | null } | null | undefined): boolean {
  return row?.role === "user" && !!row.blocks?.some((b) => b.kind === "dispatched-envelope");
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
  deps: Pick<AppContext, "getMessageById" | "loadLocalMessages" | "appendLocalMessage" | "broadcastToAll">,
  turn: { sessionKey: string; topicId: string; cause: MachineStopCause; answeredMessageId: string },
): void {
  if (!isMachineEnvelope(deps.getMessageById(turn.answeredMessageId))) return;
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
