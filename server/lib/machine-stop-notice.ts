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
import type { ContentBlock } from "../types";
import { machineStopToolError, type MachineStopCause } from "./abort-cause";

/** The block, with the sentence a client older than it prints as prose. */
export function machineStopBlock(cause: MachineStopCause): Extract<ContentBlock, { kind: "machine-stop" }> {
  return { kind: "machine-stop", cause, text: machineStopToolError(cause) };
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
