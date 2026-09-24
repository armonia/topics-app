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
 * What is dropped is reported through `onDropped`, so the loss is in the log:
 * the text of a late answer does not reach the database, and the CLI's own
 * transcript is where it can still be read.
 */
import type { StreamHandler } from "../providers/types";

const STILL_HEARD: ReadonlySet<string> = new Set(["onError", "onAborted"]);

export function silenceAfterFinalize(
  handler: StreamHandler,
  isFinalized: () => boolean,
  onDropped: (event: string) => void,
): StreamHandler {
  const guarded: Record<string, unknown> = {};
  for (const [name, callback] of Object.entries(handler)) {
    if (typeof callback !== "function" || STILL_HEARD.has(name)) {
      guarded[name] = callback;
      continue;
    }
    guarded[name] = (...args: unknown[]) => {
      if (isFinalized()) {
        onDropped(name);
        return undefined;
      }
      return (callback as (...a: unknown[]) => unknown)(...args);
    };
  }
  return guarded as unknown as StreamHandler;
}
