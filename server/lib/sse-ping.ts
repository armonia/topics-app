/**
 * KEEPS AN SSE RESPONSE OPEN THROUGH A LONG SILENCE.
 *
 * On 2026-09-24 (chat 3019832f) the response of POST /api/chat closed 255 s
 * into a silent Bash, with HTTP 200 and no `data: [DONE]`, while the turn went
 * on, and whoever was reading it took the close for the end of the turn. 255 is
 * Bun's `idleTimeout` (server.ts), and Bun resets it on every write
 * (`HttpResponse::write` calls `resetTimeout()`): a byte every 20 s is enough.
 * Measured on Bun 1.3.8 with the production values: a 300 s turn with a ping
 * every 20 s reaches `[DONE]`, the same turn silent is cut at 256 s. A relay, a
 * tunnel or a proxy on the way closes a silent stream too, and the same byte
 * keeps it open.
 *
 * An SSE comment line (`: ping`) is a byte on the wire that carries no data:
 * the spec says a line starting with a colon is ignored. Not every reader here
 * only counts `data: ` lines, though: the board's stall watch took every chunk
 * as a sign of life, and a ping every 20 s kept a stuck turn from ever being
 * judged. A reader that measures silence asks `isSseCommentOnly` first.
 *
 * It stops the moment the stream is done, whoever notices first: `stop()` from
 * the close path, or `alive()` answering false at the next tick.
 */

/** Well under the 255 s idle timeout, and under a proxy's; 60 s is a common one. */
export const SSE_PING_MS = 20_000;

const PING = new TextEncoder().encode(": ping\n\n");

export function startSsePing(opts: {
  /** Writes raw bytes to the response. Errors are the writer's to swallow. */
  write: (chunk: Uint8Array) => void;
  /** False once the stream is finished or its client is gone. */
  alive: () => boolean;
  intervalMs?: number;
}): () => void {
  const timer = setInterval(() => {
    if (!opts.alive()) { clearInterval(timer); return; }
    opts.write(PING);
  }, opts.intervalMs ?? SSE_PING_MS);
  // A ping must never be what keeps a process alive.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

const decoder = new TextDecoder();

/**
 * A chunk that is only comment lines says nothing about the turn: it is our
 * own ping. Each write of the chat route is a whole event, so a chunk read in
 * the same process never starts halfway through a line.
 */
export function isSseCommentOnly(chunk: Uint8Array | undefined): boolean {
  if (!chunk || chunk.length === 0) return false;
  const lines = decoder.decode(chunk).split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => line.startsWith(":"));
}
