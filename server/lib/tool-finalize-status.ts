/**
 * How the tools still hanging are closed when the turn ends.
 *
 * Pure on purpose, like `cancelledNotice` and `staleStreamVerdict` next door: the
 * rule lived inside `finalizeStream`, in the middle of a three-thousand-line
 * route with a real provider attached, and it was a single line —
 * `reason === 'done' ? 'success' : 'error'`.
 *
 * THE DEFECT THAT LINE HID, measured on 2026-08-28 on topic:4c935add, three
 * times out of three. The model was writing a whole document inside the argument
 * of a `write_file`; it blew through the output cap halfway into the JSON; the
 * round exited with `stopReason: "max_tokens"` BEFORE executing the tools. The
 * log keeps `Tool start: write_file` and ZERO `Tool result`, and there is no file
 * on disk. But to this line `reason` was `done`, so the tool closed with a green
 * tick and an empty result.
 *
 * A green tick on a write that never happened is worse than an error: whoever
 * reads it stops looking. The user searched `~/Downloads` for a file the system
 * declared written.
 */
import type { TurnEndInfo } from "../providers/stop-reason";

export interface ToolOutcome {
  status: "success" | "error";
  /** Present only on the error: the sentence the user reads on the tool. */
  error?: string;
}

/**
 * `reason` is how the stream ended, `turnEnd` is what the provider says.
 *
 * Only a turn that ended NORMALLY leaves successful tools behind. `max_tokens` is
 * not a normal ending: it is a cut, and the tools that were in flight when it
 * arrived never ran at all.
 */
export function toolOutcomeAtTurnEnd(
  reason: "done" | "error" | "aborted",
  turnEnd: TurnEndInfo | undefined,
  errorMsg?: string,
): ToolOutcome {
  if (reason === "aborted") return { status: "error", error: "Aborted by user" };
  if (reason === "error") return { status: "error", error: errorMsg || "Stream ended with error" };
  if (turnEnd?.end === "max_tokens") {
    return {
      status: "error",
      error: "Chiamata tagliata: il turno ha raggiunto il limite di lunghezza mentre scriveva gli argomenti",
    };
  }
  return { status: "success" };
}
