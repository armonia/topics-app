/**
 * THE VERDICT THAT ALSO SAYS WHY - one block, written in one place.
 *
 * The report, 2026-09-03: the watchdog closed a turn at 22:25 and whoever was
 * watching the chat read "stuck, no feedback at all". The only sign was a line
 * appended at the bottom of a long message, `\n\n---\n*[Response timed out]*`:
 * a footnote on an event. The real cause (the inactivity reaper had killed the
 * child process) lived in the server log, where nobody waiting for an answer
 * ever goes.
 *
 * THE RULE. Whoever closes a turn badly writes an `error` block with the cause
 * as a CODE, not just a sentence. The code is the one `stream:end` already
 * speaks (`STOP_CAUSES`): the client decides on it - which sentence to show, in
 * which language, and when to stay quiet - while on an English sentence written
 * by the server nothing can be decided, it can only be printed.
 *
 * The text stays, and stays in `content` with its warning sign: that is the
 * fallback for old clients, which cannot read a block carrying a cause.
 *
 * Idempotent like `verdettoDaApporre`: a row already explained is not rewritten.
 * Two watchdogs on the same turn (grace expiry, then the hard cap) are possible,
 * and the second must not append a second verdict.
 */
import type { ContentBlock, TurnEndCause } from "../../shared/types";

/**
 * The block to append to the turn's `blocks`, or `null` if a verdict is there.
 *
 * `at` comes from the caller instead of the clock here: a test that injects the
 * instant should not have to stop time to check it.
 */
export function interruptedTurnBlock(
  blocks: ContentBlock[] | null | undefined,
  input: { text: string; cause: TurnEndCause; at: string },
): ContentBlock | null {
  if (Array.isArray(blocks) && blocks.some((b) => b?.kind === "error")) return null;
  return { kind: "error", text: stripNoticePrefix(input.text), cause: input.cause, at: input.at };
}

/**
 * The warning sign marks the OLD format, the one living inside `content`.
 *
 * Inside an `error` block it would be doubled noise: the bubble already draws
 * the frame, and the banner above the composer puts its own icon back. Same
 * cleanup the other pens writing this block in `chat.ts` already do.
 */
function stripNoticePrefix(text: string): string {
  return text.replace(/^\u26a0\ufe0f\s*/, "").trim();
}

/**
 * The same verdict, appended in place, ready for `updateLastMessage`.
 *
 * `undefined` when there is nothing to write: passing an empty array would
 * blank the column (see `appendErrorBlock` in `routes/chat.ts`).
 */
export function appendInterruptedVerdict(
  blocks: ContentBlock[],
  input: { text: string; cause: TurnEndCause; at?: string },
): ContentBlock[] | undefined {
  const block = interruptedTurnBlock(blocks, { ...input, at: input.at ?? new Date().toISOString() });
  if (block) blocks.push(block);
  return blocks.length > 0 ? blocks : undefined;
}
