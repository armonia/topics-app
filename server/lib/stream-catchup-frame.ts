/**
 * The `stream:catchup` frame, built in ONE place.
 *
 * Every WS connect (browser refresh, second window, network reconnect, a pane
 * mounting) replays the turns still in flight to the newcomer, so it sees the
 * tool calls that already ran instead of a wall of text arriving at once.
 * That replay used to ship the partial message as the DB hands it over, and
 * the DB hands it over TWICE: `rowToMessage` (server/utils.ts) rebuilds the
 * legacy `toolCalls` bucket from the blocks when the column is empty, so the
 * same objects travelled in `blocks` and next to them. Measured on 2026-09-07
 * against a running instance with 4 turns in flight: 2,828,244 B of
 * `stream:catchup` on a single socket open.
 *
 * Two cuts, and the second is the one that needs care:
 *
 *  1. `toolCalls: undefined` when the message has blocks. Same rule
 *     `leanMessageForWire` applies to closed messages: the renderer reads the
 *     blocks ("When present and non-empty, [blocks] takes precedence over the
 *     legacy thinking/toolCalls/content bucket", MessageContent.tsx), and the
 *     client merge treats an absent `toolCalls` as "keep what you have"
 *     (streamCatchupMerge.ts), so the bucket is pure weight.
 *
 *  2. The large text inside a tool call is blanked ONLY on the calls that are
 *     over (`success` / `error`), and `detailBytes` / `argsBytes` say how much
 *     was removed. A closed row fetches its body from the detail route when it
 *     is opened, exactly as history does; a row that is STILL RUNNING does not,
 *     because there the live output is what the reader is watching. Hence the
 *     status test rather than a blanket strip: `pending`, `running`,
 *     `waiting_for_input`, `awaiting_permission` and an absent status all keep
 *     their text whole.
 *
 * Not a lean of the whole partial message: `content` and `thinking` are the
 * text of the turn as it is being written and there is nothing else carrying
 * them.
 *
 * And one addition, the opposite of a cut: a tool still running travels with
 * its live output (`ActiveStream.liveToolTails`, at most 16 KB each) as its
 * `result`. The row on disk never has it, so without this every reopen wiped
 * the running shell's output from the screen (lib/live-tool-tail.ts).
 */
import { stripArgsText, stripDetailText } from "../../shared/lean-tool-call";
import type { ActiveStream, StoredMessage } from "../types";
import type { ContentBlock, ToolCall, ToolCallStatus } from "../../shared/types";

/** Has this tool call finished? Only then does the database hold its whole text. */
function isFinished(status: ToolCallStatus | undefined): boolean {
  return status === "success" || status === "error";
}

/** `leanToolCallForHistory`, but only on a call that has stopped moving. */
function leanFinishedToolCall<T extends ToolCall>(tc: T): T {
  if (!tc || !isFinished(tc.status)) return tc;
  return stripArgsText(stripDetailText(tc));
}

/** The blocks with every FINISHED tool call trimmed; same reference if none was. */
function leanFinishedBlocks(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    const block = b as { toolCall?: ToolCall };
    if (!b || typeof b !== "object" || !block.toolCall) return b;
    const lean = leanFinishedToolCall(block.toolCall);
    if (lean === block.toolCall) return b;
    changed = true;
    return { ...b, toolCall: lean } as ContentBlock;
  });
  return changed ? out : blocks;
}

/** Same, on the flat legacy bucket (a row persisted before blocks existed). */
function leanFinishedToolCalls(calls: readonly ToolCall[]): readonly ToolCall[] {
  let changed = false;
  const out = calls.map((tc) => {
    const lean = leanFinishedToolCall(tc);
    if (lean !== tc) changed = true;
    return lean;
  });
  return changed ? out : calls;
}

/** A running call with a live tail gets it as `result`; anything else, the same reference. */
function withLiveTail<T extends ToolCall>(tc: T, tails: ReadonlyMap<string, string>): T {
  if (!tc || isFinished(tc.status)) return tc;
  const tail = tails.get(tc.id);
  return tail ? { ...tc, result: tail } : tc;
}

/** The blocks with every running call's live tail on it; same reference if none had one. */
function withLiveTailBlocks(blocks: readonly ContentBlock[], tails: ReadonlyMap<string, string>): readonly ContentBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    const block = b as { toolCall?: ToolCall };
    if (!b || typeof b !== "object" || !block.toolCall) return b;
    const live = withLiveTail(block.toolCall, tails);
    if (live === block.toolCall) return b;
    changed = true;
    return { ...b, toolCall: live } as ContentBlock;
  });
  return changed ? out : blocks;
}

/**
 * The partial row with each running tool's live tail as its `result`, in the
 * blocks and in the legacy bucket; the same reference when there is nothing to
 * put. Both readers of a turn in flight go through here: the catch-up frame
 * and the history page (`routes/history.ts`), which a reopening window reads
 * right AFTER its catch-up and whose copy wins on screen (CHAT-TOOL-11).
 */
export function withLiveToolTails<M extends { toolCalls?: readonly ToolCall[]; blocks?: readonly ContentBlock[] }>(
  message: M,
  tails: ReadonlyMap<string, string> | undefined,
): M {
  if (!tails?.size) return message;
  const blocks = message.blocks?.length ? withLiveTailBlocks(message.blocks, tails) : message.blocks;
  const toolCalls = message.toolCalls?.length ? message.toolCalls.map((tc) => withLiveTail(tc, tails)) : message.toolCalls;
  const callsChanged = !!toolCalls && toolCalls.some((tc, i) => tc !== message.toolCalls![i]);
  if (blocks === message.blocks && !callsChanged) return message;
  return { ...message, blocks, toolCalls: callsChanged ? toolCalls : message.toolCalls };
}

/** What the frame carries of the partial message, once trimmed. */
export interface CatchupMessagePayload {
  toolCalls?: readonly ToolCall[];
  blocks?: readonly ContentBlock[];
}

/**
 * The `toolCalls` / `blocks` pair as the catchup ships them.
 *
 * `toolCalls` is left in place only when there are no blocks to read it from:
 * dropping it there would leave the newcomer with a turn that has no tools at
 * all, which is the bug this catchup exists to prevent.
 */
export function leanCatchupMessage(partial: Pick<StoredMessage, "toolCalls" | "blocks">): CatchupMessagePayload {
  const blocks = partial.blocks?.length ? leanFinishedBlocks(partial.blocks) : partial.blocks;
  if (partial.blocks?.length) return { toolCalls: undefined, blocks };
  const toolCalls = partial.toolCalls?.length ? leanFinishedToolCalls(partial.toolCalls) : partial.toolCalls;
  return { toolCalls, blocks };
}

/** The stream state the frame is built from: the registry entry, minus what it does not ship. */
export type CatchupStreamState = Pick<ActiveStream, "content" | "thinking" | "isThinking" | "messageId" | "retry" | "slow" | "liveToolTails">;

/**
 * The whole `stream:catchup` frame for one active stream.
 *
 * Kept out of the WS open handler so the payload it puts on the wire can be
 * asserted without a socket: see tests/integration/catchup-payload-weight.test.ts.
 */
export function buildStreamCatchupFrame(args: {
  sessionKey: string;
  topicId: string | undefined;
  stream: CatchupStreamState;
  partial: Pick<StoredMessage, "toolCalls" | "blocks">;
}): Record<string, unknown> {
  const { sessionKey, topicId, stream, partial } = args;
  const { toolCalls, blocks } = withLiveToolTails(leanCatchupMessage(partial), stream.liveToolTails);
  return {
    type: "stream:catchup",
    sessionKey,
    topicId,
    messageId: stream.messageId,
    content: stream.content,
    thinking: stream.thinking,
    isThinking: stream.isThinking,
    toolCalls,
    blocks,
    // The wait the turn is in, if any: `stream:retry` / `stream:slow`
    // were broadcast before this client existed (`ActiveStream.retry`).
    ...(stream.retry ? { retry: stream.retry } : {}),
    ...(stream.slow ? { slow: true } : {}),
  };
}
