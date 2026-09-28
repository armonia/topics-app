/**
 * THE CLAUDE HOLD, AS THE OPEN WINDOWS AND THE RESUME SWEEP HEAR OF IT.
 *
 * Two readers of every change. The status bar's banner says why nothing moves
 * and until when, instead of a spinner and 27 silent retries. And the resume
 * sweep: a hold lifted early (the API answered again, a window freed) is when
 * the chats it deferred can go, within the nudge and not at the next
 * five-minute tick. On 25/09 that would have resumed topic 3019832f at about
 * 03:20:20Z, before the manual resend at 03:22 (card e30f35e4).
 */
import type { ProviderHold } from "./provider-hold";

/** The hold as the status bar's banner reads it. An API outage goes out as no
 *  hold: the banner speaks of a plan limit, and the cut chat's own notice
 *  already says the API stopped answering. */
export function providerHoldFrame(hold: ProviderHold | null) {
  return hold && hold.window !== "api-down"
    ? { type: "provider:hold" as const, untilMs: hold.untilMs, window: hold.window, reason: hold.reason, sinceMs: hold.sinceMs }
    : { type: "provider:hold" as const, untilMs: null, window: null, reason: null, sinceMs: null };
}

/** Every change goes out to the windows; a lift also nudges the sweep. */
export function wireHoldToResume(
  subscribe: (cb: (hold: ProviderHold | null) => void) => () => void,
  deps: { broadcast: (frame: ReturnType<typeof providerHoldFrame>) => void; nudge: () => void },
): () => void {
  return subscribe((hold) => {
    deps.broadcast(providerHoldFrame(hold));
    if (!hold) deps.nudge();
  });
}
