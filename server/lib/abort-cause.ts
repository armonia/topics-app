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
 * A stop the machine WANTED (a land, a delegation's deadline, the stall judge)
 * takes the path every route stop took before, through the finalize with its
 * true cause (fourth review of PR #135): no notice, an empty row discarded,
 * its tools closed with a sentence of their own, and the sweep reads the chat
 * as it did then. The only difference is that it is not written down as the
 * person's.
 *
 * Only a request built inside the server can name a machine cause: the mark
 * lives on the Request object, which a client cannot forge. Anything else is
 * the person, whatever its body or headers claim.
 */
import type { MachineStopCause } from "../../shared/types";
export type { MachineStopCause } from "../../shared/types";
export type StopCause = "user" | MachineStopCause;

export const MACHINE_STOP_CAUSE_LIST: readonly MachineStopCause[] = ["stall", "superseded", "wall-clock"];
const MACHINE_STOP_CAUSES: ReadonlySet<string> = new Set<string>(MACHINE_STOP_CAUSE_LIST);

export function isMachineStop(cause: unknown): cause is MachineStopCause {
  return typeof cause === "string" && MACHINE_STOP_CAUSES.has(cause);
}

/** A stop somebody asked for: the person, or the machine on purpose. Its end explains nothing. */
export function isWantedStop(cause: unknown): boolean {
  return cause === "user" || isMachineStop(cause);
}

/**
 * What a tool still open says when the machine stopped its turn on purpose.
 * Never the interrupted prefix: the boot's repair pass (`bonificaTurniMuti`)
 * reads that as a turn cut with no explanation and marks it to be resumed.
 */
export function machineStopToolError(cause: MachineStopCause): string {
  switch (cause) {
    case "stall": return "Fermato: il turno è stato riciclato perché sembrava fermo";
    case "superseded": return "Fermato: il lavoro della card è già atterrato o è passato altrove";
    case "wall-clock": return "Fermato: la delega ha raggiunto la durata massima";
  }
}
const internalRequests = new WeakSet<Request>();

/**
 * The same cause on a request that stops a turn indirectly, through a route
 * the person also uses: the board's DELETE of a card, which the server sends
 * itself when another machine revokes a delegated card.
 */
export const STOP_CAUSE_HEADER = "x-topics-stop-cause";

/** A request the server builds for its own routes, marked as such. */
export function internalRequest(url: URL | string, init: RequestInit): Request {
  const req = new Request(url, init);
  internalRequests.add(req);
  return req;
}

/** Who stopped the turn: the cause `declared` counts only on a request the server built. */
export function stopCauseOf(req: Request, declared: unknown): StopCause {
  return internalRequests.has(req) && typeof declared === "string" && MACHINE_STOP_CAUSES.has(declared)
    ? (declared as MachineStopCause)
    : "user";
}

/** The request a caller inside the server sends to `/api/chat/abort`. */
export function internalAbortRequest(sessionKey: string, cause: StopCause): Request {
  return internalRequest("http://localhost/api/chat/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, cause }),
  });
}
