/**
 * WHO STOPPED A TURN, said by whoever stops it (card C9).
 *
 * `/api/chat/abort` has two kinds of callers: the person's client (the Stop
 * button) and the server's own machinery (the stall judge of a headless
 * reattach, the board, the dispatcher's clocks). The route signed every stop
 * as the person's. With the durable Stop (`logStopPressed`, which keeps the
 * resume sweep from resending a message the person stopped) that turned a
 * machine's recycle into a human Stop: on 25/09 the stall judge SIGINTed the
 * home chat 3019832f while it only waited for its background agent, the log
 * said "user stop", and after a restart the message would never be resumed.
 *
 * The client never sends a `cause`, so a request without one is the person's.
 * A caller inside the server always sends one, and it is `user` only when a
 * person pressed something (the board's Stop).
 */
import { STOP_CAUSES } from "../../shared/ws-outbound";
import type { TurnEndCause } from "../../shared/types";
import type { AbortReason } from "../providers/types";

export function abortCauseOf(body: { cause?: unknown } | null | undefined): TurnEndCause {
  const cause = body?.cause;
  return typeof cause === "string" && (STOP_CAUSES as readonly string[]).includes(cause)
    ? (cause as TurnEndCause)
    : "user";
}

/** The provider's word for it: it knows three, and only a person is `user`. */
export function providerAbortReason(cause: TurnEndCause): AbortReason {
  return cause === "user" || cause === "server-shutdown" ? cause : "watchdog";
}

/** The request a caller inside the server sends to `/api/chat/abort`. */
export function internalAbortRequest(sessionKey: string, cause: TurnEndCause): Request {
  return new Request("http://localhost/api/chat/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, cause }),
  });
}
