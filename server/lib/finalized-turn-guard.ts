/**
 * A FINALIZED TURN IS DEAF (card 1046df0b, C3).
 *
 * The chat route closes a turn in several places (the grace watchdog, the hard
 * cap, an external abort, the normal end), and after that the turn's
 * StreamHandler can still be reached: a send still waiting in the provider's
 * queue installs that same handler on a fresh child and the CLI answers into
 * it (C2). Every callback then did its job as if the turn were live: it grew
 * `fullContent` behind the timeout text, wrote rows, pushed stream frames and
 * bumped the session's in-memory stream, which by then belongs to another
 * turn. On 24/09 (chat 3019832f) that rewrote six resume notices in a row.
 *
 * Checking `streamState` inside each callback is how the first ones were
 * missed: the diagnosis named four writers and there were more. So the rule
 * wraps the handler once and is closed by default: a callback added tomorrow
 * is silenced too, without anyone remembering to.
 *
 * What still passes is the pair the route EXPECTS after its own close: it
 * aborts the provider turn itself (so `onAborted` follows every watchdog close)
 * and a killed send rejects (`onError`). Both only reach `finalizeStream`,
 * which is idempotent, and `onError` also rolls back the inline preamble mark,
 * which stays right for a turn that never finished.
 *
 * And two facts about the SESSION rather than the turn: a compaction
 * (`onCompaction`) and the context size (`onContextSize`). They go to their own
 * tables, never to a message row, and they stay true whoever was listening. The
 * compaction marker is also what resets the inline-preamble dedup: dropped, the
 * turns after a late auto-compaction would go out without the topic context
 * the CLI has just summarised away (review of card 1046df0b).
 *
 * What is dropped is reported through `onDropped`, so the loss is in the log:
 * the text of a late answer does not reach the database, and the CLI's own
 * transcript is where it can still be read.
 */
import type { StreamHandler } from "../providers/types";

const STILL_HEARD: ReadonlySet<string> = new Set(["onError", "onAborted", "onCompaction", "onContextSize"]);

/**
 * A QUESTION IS THE ONE LATE THING THAT MUST STILL REACH A PERSON.
 *
 * When a late answer asks the human (`onUserInputRequired`), the CLI stops and
 * waits for the reply: dropped, the question is on no row and on no screen, the
 * CLI holds the session's queue for the ask's whole TTL, and the next message
 * waits behind it until someone presses Stop. Before the guard the question at
 * least landed on a row and could be answered. Releasing the wait at drop time
 * does not work: the tool is announced before the CLI runs it, so there is
 * nothing to release yet (verified in the review of card 1046df0b).
 *
 * So the question is let through, onto the closed turn's own row (every write
 * of the route is by row id). Its announcement and its arguments were dropped
 * before anyone knew it was a question, so they are kept per tool id and
 * replayed first; from then on only the events of THAT tool pass, the result
 * included, which is what closes the panel. The rest of the late answer stays
 * dropped.
 */
const PER_TOOL: ReadonlySet<string> = new Set([
  "onToolArgsUpdate", "onToolExecStart", "onToolActivity", "onToolUpdate", "onToolResult", "onToolUsage",
]);

export function silenceAfterFinalize(
  handler: StreamHandler,
  isFinalized: () => boolean,
  onDropped: (event: string) => void,
): StreamHandler {
  const call = (name: string, args: unknown[]) =>
    (handler as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args);
  const announced = new Map<string, { start?: unknown[]; args?: unknown[] }>();
  const questions = new Set<string>();

  const guarded: Record<string, unknown> = {};
  for (const [name, callback] of Object.entries(handler)) {
    if (typeof callback !== "function" || STILL_HEARD.has(name)) {
      guarded[name] = callback;
      continue;
    }
    guarded[name] = (...args: unknown[]) => {
      if (!isFinalized()) return (callback as (...a: unknown[]) => unknown)(...args);
      const toolId = typeof args[0] === "string" ? args[0] : "";
      if (name === "onUserInputRequired" && toolId) {
        if (!questions.has(toolId)) {
          questions.add(toolId);
          const seen = announced.get(toolId);
          if (seen?.start) call("onToolStart", seen.start);
          if (seen?.args) call("onToolArgsUpdate", seen.args);
          announced.delete(toolId);
        }
        return (callback as (...a: unknown[]) => unknown)(...args);
      }
      if (PER_TOOL.has(name) && questions.has(toolId)) {
        return (callback as (...a: unknown[]) => unknown)(...args);
      }
      if (toolId && (name === "onToolStart" || name === "onToolArgsUpdate")) {
        const seen = announced.get(toolId) ?? {};
        if (name === "onToolStart") seen.start = args;
        else seen.args = args;
        announced.set(toolId, seen);
      }
      onDropped(name);
      return undefined;
    };
  }
  return guarded as unknown as StreamHandler;
}
