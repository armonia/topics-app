/**
 * KEEPS AN SSE RESPONSE OPEN THROUGH A LONG SILENCE, FOR WHOEVER IS IN BETWEEN.
 *
 * On 2026-09-24 (chat 3019832f) the response of POST /api/chat closed 255 s
 * into a silent Bash, with HTTP 200 and no `data: [DONE]`, while the turn went
 * on, and whoever was reading it took the close for the end of the turn. 255
 * was Bun's `idleTimeout`, and Bun counts no server write as activity: measured
 * with a write every 300 ms, a 1 s idle timeout still cut the response at 4 s.
 * So the idle timeout is off (server.ts), and a keepalive could never have
 * been the fix on Bun's side.
 *
 * It is still needed on the way: a relay, a tunnel or a dev proxy closes a
 * stream that says nothing, and those do count bytes. An SSE comment line
 * (`: ping`) every 20 s is a byte on the wire that no reader treats as data:
 * the spec says a line starting with a colon is ignored, and every reader here
 * only looks at `data: ` lines. It stops the moment the stream is done,
 * whoever notices first: `stop()` from the close path, or `alive()` answering
 * false at the next tick.
 */

/** Well under the idle timeout of a proxy on the way; 60 s is a common one. */
export const SSE_KEEPALIVE_MS = 20_000;

const PING = new TextEncoder().encode(": ping\n\n");

export function startSseKeepalive(opts: {
  /** Writes raw bytes to the response. Errors are the writer's to swallow. */
  write: (chunk: Uint8Array) => void;
  /** False once the stream is finished or its client is gone. */
  alive: () => boolean;
  intervalMs?: number;
}): () => void {
  const timer = setInterval(() => {
    if (!opts.alive()) { clearInterval(timer); return; }
    opts.write(PING);
  }, opts.intervalMs ?? SSE_KEEPALIVE_MS);
  // A ping must never be what keeps a process alive.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
