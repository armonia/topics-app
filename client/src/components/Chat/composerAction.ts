/**
 * Decide what the single composer button in `ChatInput` should do RIGHT NOW.
 *
 * We collapse four UI choices (send, stop, queue, disabled) into a pure
 * function of two booleans so the JSX in `ChatInput.tsx` stops carrying the
 * branching logic in its className/disabled/title attributes (where it had
 * grown unreadable) and so the rules are unit-testable.
 *
 * Product rules — agreed with the user, see commit history for context:
 *
 *   ─ idle & input empty         → disabled (nothing to do)
 *   ─ idle & input has content   → send (submit message)
 *   ─ busy & input empty         → stop (abort the in-flight turn)
 *   ─ busy & input has content   → queue (accoda; will auto-send on stream end)
 *
 * "Busy" is anything that means the agent owns the turn right now:
 * streaming tokens, waiting for the first token after submit (loading),
 * a thinking block in progress, OR a tool call that has paused the stream
 * to ask the user for input via the upcoming `waiting_for_input` state.
 * Treating `waiting_for_input` as busy keeps Stop available as an escape
 * hatch even while the form is open — abort cancels the whole turn,
 * including the pending question.
 *
 * The "has content" signal is broader than "non-empty textarea": pending
 * files and pasted images also count, because clicking Send with no typed
 * text but an attached image is a legitimate submit.
 */

export type ComposerAction =
  | { kind: "send" }
  | { kind: "stop" }
  | { kind: "queue" }
  | { kind: "disabled" };

export interface ComposerActionInput {
  /**
   * True when the composer has *something* to submit: typed text, a pending
   * file attachment, or a pasted image. Determines whether the busy-state
   * button is "queue this for after the stream" vs "stop the stream".
   */
  hasContent: boolean;
  /**
   * True when the assistant currently owns the turn: streaming, loading
   * (post-submit pre-first-token), thinking, or waiting for the user to
   * answer a tool's `AskUserQuestion`-style request. While busy, the
   * primary button is never "send" — it's "stop" or "queue" depending on
   * whether the composer has anything in it.
   */
  busy: boolean;
}

export function decideComposerAction(input: ComposerActionInput): ComposerAction {
  if (input.busy) {
    return input.hasContent ? { kind: "queue" } : { kind: "stop" };
  }
  return input.hasContent ? { kind: "send" } : { kind: "disabled" };
}
