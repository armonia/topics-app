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

/**
 * When the nudges go out, in ms after the last write: every 40 ms for the first
 * 400, then 600 ms, 1, 2 and 4 s. Each one is another chance to reach the page
 * on its own (`createSseNudge`). Close together at first, because a page busy
 * past a nudge strands it with the burst, and the first one after the page is
 * free is the one that counts. With nudges at 40 and 250 ms only, the window
 * that sent a turn saw a tool running past the 250 ms that open its body
 * (`AUTO_OPEN_DELAY_MS` in the client), and the body closed 1.5 s later under
 * the answer (WebKit, chat-turn-end-still `twotool`, 3 runs in 20 of run
 * 42337916608; never in Chromium, which strands nothing). Then further apart,
 * so a long silence costs a few dozen bytes, not a stream of them.
 */
export const SSE_NUDGE_DELAYS_MS: readonly number[] = [
  ...Array.from({ length: 10 }, (_, i) => (i + 1) * 40),
  600, 1_000, 2_000, 4_000,
];

const NUDGE = new TextEncoder().encode(": nudge\n\n");

/**
 * PUSHES OUT THE LAST FRAMES BEFORE A SILENCE.
 *
 * WebKit can sit on the last bytes of a streamed response until more bytes
 * follow (Playwright's WebKit: on the Mac measured below, in CI on Linux the
 * same +20 s on every tool turn). Measured on 05/11 through a timestamping TCP
 * relay between a WebKit page and the server:
 * Bun wrote the answer's frame and the relay forwarded it at once, and the
 * page's `reader.read()` got it 19.4 s later, in the same millisecond as the
 * 20 s ping. It happens when frames come in a burst (three tool results and the
 * answer's text within 5 ms) and the server then goes quiet, which is every
 * turn that runs a tool: the sender window, which reads only this stream, saw
 * the second tool still running and no answer until the ping. A Node client
 * reading the same stream never waited (25 turns out of 25), and neither did
 * the stream shapes of the server tried (plain, direct with flush): the hold is
 * in the browser, not in what we write.
 *
 * The mechanism is WebKit bug 322545, a regression of the fetch byte stream
 * that ships on by default (Safari 26, and the WKWebView of the desktop app):
 * bytes that reach the page while its reader has no read pending are stashed,
 * and only a LATER chunk that arrives while a read is pending releases them;
 * reading again does not. A page whose main thread was busy gets a burst of
 * frames in one go, and the tail of the burst is stranded.
 *
 * So after a write, and as long as nothing else is written, this sends one
 * comment line at each of `delaysMs`, the same kind of byte as the ping. One
 * line is not always enough: on a loaded CI runner the page stayed busy past
 * the first one, which reached it in the same go as the burst and was
 * stranded with it (the window that sent the turn showed its first tool
 * running until the end of the turn, run 42334875663, WebKit). A later one
 * reaches it on its own, once the reader has asked again, and the sooner it
 * follows the end of the busy stretch, the less the page sees late. If WebKit
 * holds a nudge, nothing is lost: it carries nothing. A reader that measures
 * silence asks `isSseCommentOnly` first, as it does for the ping.
 */
export function createSseNudge(opts: {
  /** Writes raw bytes to the response. Errors are the writer's to swallow. */
  write: (chunk: Uint8Array) => void;
  /** False once the stream is finished or its client is gone. */
  alive: () => boolean;
  /** When the nudges go out, in ms after the last write (`SSE_NUDGE_DELAYS_MS`). */
  delaysMs?: readonly number[];
}): { touch: () => void; stop: () => void } {
  const delays = opts.delaysMs ?? SSE_NUDGE_DELAYS_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // The nudge due at `delays[index]`, `elapsed` ms after the last write, then the next one.
  const schedule = (index: number, elapsed: number) => {
    const at = delays[index];
    if (at === undefined) return;
    timer = setTimeout(() => {
      timer = null;
      if (!opts.alive()) return;
      opts.write(NUDGE);
      schedule(index + 1, at);
    }, at - elapsed);
    // A nudge must never be what keeps a process alive.
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    // Called after every write: the nudges go out only while the stream stays quiet.
    touch: () => {
      stop();
      schedule(0, 0);
    },
    stop,
  };
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
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
