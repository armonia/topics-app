/**
 * Stream text helpers shared by the topics router and the extracted chat
 * streaming engine (chat.ts): the slow-stream annotation marker + its strip
 * helper, and the marker-aware broadcast-delta computation. Pulled out of
 * topics.ts so chat.ts can import them without a topics<->chat import cycle.
 */
import { CLOSED_MARKER_REGEX, OPEN_MARKER_TAIL_REGEX } from "../lib/markers";

/**
 * Marker appended to a partial assistant message when the soft inactivity
 * timeout fires but we are still listening for the provider to recover.
 * Visible to the client so the user knows we noticed the slowness, but
 * intentionally NOT a hard "[Response timed out]" — the stream may still
 * resume during the grace period.
 *
 * The leading `\n\n---\n*` and trailing `*` brackets are how we round-trip:
 * callers append `STREAM_SLOW_ANNOTATION` inline and `stripSlowAnnotation()`
 * removes it by suffix match, with no risk of clobbering legitimate content.
 * Keep the entire substring stable — modifying it requires updating the strip
 * helper too.
 */
export const STREAM_SLOW_ANNOTATION = "\n\n---\n*[⏱ stream lento — il provider è ancora connesso]*";

/**
 * Compute the next visible delta to broadcast given the accumulated server-side
 * `fullContent` and the cumulative clean text already broadcast. Returns the
 * new clean text + the delta to send (which may be empty).
 *
 * Behavior covered:
 *   1. Closed markers (`{{NAME:body}}`) are dropped entirely from the clean
 *      cumulative, so a chunk landing right at the close emits only the
 *      text that follows the marker.
 *   2. An unclosed marker tail (`...{{NAME:partial`) at end-of-string is
 *      hidden until the close arrives in a later chunk.
 *   3. Defensive non-monotonic case: if the new clean cumulative would be
 *      shorter than the previously broadcast prefix (shouldn't happen with
 *      the existing detect-and-strip flow, but guards against future
 *      changes), we re-baseline silently and skip this delta — `stream:end`
 *      then reconciles the final content.
 *
 * Pure function: same inputs, same outputs, no globals. Allows the unit
 * test in routes/topics-marker-strip.test.ts to lock in the contract.
 */
export function computeCleanBroadcastDelta(
  fullContent: string,
  lastBroadcastClean: string,
): { cumulativeClean: string; delta: string } {
  const cumulativeClean = fullContent
    .replace(CLOSED_MARKER_REGEX, "")
    .replace(OPEN_MARKER_TAIL_REGEX, "");
  if (cumulativeClean.startsWith(lastBroadcastClean)) {
    return {
      cumulativeClean,
      delta: cumulativeClean.slice(lastBroadcastClean.length),
    };
  }
  return { cumulativeClean, delta: "" };
}

export function stripSlowAnnotation(content: string): string {
  if (!content.endsWith(STREAM_SLOW_ANNOTATION)) return content;
  return content.slice(0, -STREAM_SLOW_ANNOTATION.length);
}
