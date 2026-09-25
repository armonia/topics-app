/**
 * WHAT A FINALIZED TURN STILL HEARS, AND WHERE IT GOES (card 1046df0b, C3).
 *
 * The chat route closes a turn in several places (the grace watchdog, the hard
 * cap, an external abort, the normal end), and after that the turn's
 * StreamHandler can still be reached: a send still waiting in the provider's
 * queue installs that same handler on a fresh child and the CLI answers into
 * it (C2). Every callback then did its job as if the turn were live, on
 * whatever row was last: on 24/09 (chat 3019832f) that rewrote six resume
 * notices in a row.
 *
 * Dropping the late answer was the first fix, and the review of PR #135 showed
 * it costs twice: the final answers stay lost (the card's own symptom), and the
 * sweep, finding the message still cut, resends it once more although the CLI
 * had already executed it. So the late answer is KEPT, on the turn's own row,
 * under the cut (Attilio's decision). Three lanes, decided once here:
 *
 *   - `late`: the route's late handlers, for what must not run the live code
 *     (text, thinking, the end: the live ones grow the content behind the
 *     timeout text, touch the session's live stream and finalize), and for
 *     `onError`, whose live version rolls back the inline-preamble mark of
 *     whatever turn comes next;
 *   - `STILL_HEARD`: the live callbacks that are already safe after the close,
 *     because every write they do is by row id and their frames name the row:
 *     the whole tool lifecycle (a question or a permission of a late answer
 *     must reach the person, or the CLI holds the session for the ask's TTL),
 *     plus the session's own facts (compaction, context size) and `onAborted`,
 *     which only reaches the idempotent finalize;
 *   - everything else is dropped and reported through `onDropped`: usage,
 *     retries, plans, and any callback added tomorrow, closed by default.
 */
import type { StreamHandler } from "../providers/types";

const STILL_HEARD: ReadonlySet<string> = new Set([
  "onToolStart", "onToolArgsUpdate", "onToolExecStart", "onToolActivity", "onToolUpdate",
  "onToolResult", "onToolUsage", "onUserInputRequired", "onSubAgentUpdate",
  "onCompaction", "onContextSize", "onAborted",
]);

export function guardFinalizedTurn(
  handler: StreamHandler,
  isFinalized: () => boolean,
  late: Partial<StreamHandler>,
  onDropped: (event: string) => void,
): StreamHandler {
  const lateCallbacks = late as Record<string, ((...a: unknown[]) => unknown) | undefined>;
  const guarded: Record<string, unknown> = {};
  for (const [name, callback] of Object.entries(handler)) {
    if (typeof callback !== "function") {
      guarded[name] = callback;
      continue;
    }
    guarded[name] = (...args: unknown[]) => {
      if (!isFinalized()) return (callback as (...a: unknown[]) => unknown)(...args);
      const lateCallback = lateCallbacks[name];
      if (lateCallback) return lateCallback(...args);
      if (STILL_HEARD.has(name)) return (callback as (...a: unknown[]) => unknown)(...args);
      onDropped(name);
      return undefined;
    };
  }
  return guarded as unknown as StreamHandler;
}
