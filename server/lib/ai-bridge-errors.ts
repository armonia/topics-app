// The ways a request to the ai-bridge daemon fails, and which of them are worth
// a second attempt. Out of `ai-bridge-client.ts`, which re-exports them.

/**
 * The failure is the CONNECTION, not the daemon.
 *
 * Telling them apart is what makes a second attempt sensible: if the frame
 * never left (a socket just dropped, a reconnect in progress), retrying is right
 * and fixes it; if the daemon received it and stays silent, retrying only
 * doubles the wait. The bridge's three requests (spawn, attach, list) are
 * idempotent by construction (a `spawn` on a live session RESUMES it, an
 * `attach` replays from the same offset), so the second attempt is safe.
 */
export class BridgeConnectionLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConnectionLost";
  }
}

/**
 * The bridge stayed SILENT past the deadline: neither the ack nor a single byte
 * for any other session.
 *
 * Apart from `BridgeConnectionLost` because it tells a different failure (there
 * the frame never left, here it left and nothing came back), but it shares the
 * one property that matters to whoever catches it: it can be RETRIED. It used to
 * be a bare `Error`, and bare meant final: one late ack and the turn died with
 * «Riadozione del turno non riuscita» in the chat, even when the `claude` child  allow-italian: quotes the notice the chat shows
 * was working fine inside the daemon.
 */
export class BridgeAckStalled extends Error {
  /**
   * Is resending the frame worth it? YES when the bridge was truly silent. NO
   * when what ran out is the absolute cap while bytes were still flowing:
   * resending an `attach` there redoes from scratch the same megabyte replay
   * that was already arriving, fuel on the queue that caused the wait.
   */
  readonly retryable: boolean;
  /**
   * On the cap, the reply still on its way: the daemon answers later on the same
   * socket, behind the bytes that were flowing. Settles with that reply, or with
   * `null` if the socket goes first. Absent when the daemon echoes no rids.
   */
  readonly late?: Promise<unknown>;
  constructor(message: string, retryable: boolean, late?: Promise<unknown>) {
    super(message);
    this.name = "BridgeAckStalled";
    this.retryable = retryable;
    this.late = late;
  }
}

/** Is resending the frame worth it? True for the two TRANSPORT failures, never
 *  for an application `error` of the daemon, which would answer the same again. */
export function isRetryableBridgeError(e: unknown): boolean {
  if (e instanceof BridgeConnectionLost) return true;
  return e instanceof BridgeAckStalled && e.retryable;
}

/**
 * The watchdog's verdict, pulled out because it is ONE line with two ways of
 * being wrong, and neither can be waited out for 45 seconds in a test.
 *
 * A late pong is NOT enough to call the bridge dead: it travels on the same
 * queue as everything else, and during a heavy re-attach it ends up behind tens
 * of MB of replay. If BYTES arrived meanwhile the daemon is alive, and recycling
 * the socket there is the worst move there is: it drops every attach and starts
 * every replay over.
 */
export function shouldRecycleSocket(now: number, lastPongAt: number, lastByteAt: number, pongTimeoutMs: number): boolean {
  return now - lastPongAt > pongTimeoutMs && now - lastByteAt > pongTimeoutMs;
}
