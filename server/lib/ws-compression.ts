/**
 * Nothing on this server's WebSocket is compressed: `Bun.serve`'s `websocket`
 * block sets no `perMessageDeflate`, and Bun's default is off. HTTP JSON is
 * compressed now (see `compress-json.ts`), the socket is not, and the socket is
 * where the first screen comes from.
 *
 * Measured on this machine on 2026-08-14, one fresh connection to the live
 * server on :3333, 75 s of listening on `/ws`:
 *
 *   ui-state:init        86,222 B -> 20,872 B  (4.13x)   0.77 ms of gzip
 *   unread:init          81,713 B -> 24,936 B  (3.28x)   0.76 ms
 *   providers:snapshot    2,034 B ->    734 B  (2.78x)   0.01 ms
 *   everything else          852 B (8 frames, none over 320 B)
 *
 * 172.3 KB in the first second, 99.5% of it in the 4 frames at or above one
 * MTU, and 124 KB of it removable for about 1.5 ms of CPU. Over a LAN at ~20
 * Mbit that is most of a second in which the app has no state to draw. A second
 * capture over 5 minutes found the same burst and 2.7 KB of steady state after
 * it, so the bootstrap is not a share of the traffic on this socket: it is the
 * traffic.
 *
 * ## Why a predicate and not a switch
 *
 * The same `websocket` handler serves three sockets: the app socket (`/ws`),
 * the terminal socket (`/ws/terminal/:id`) and the browser socket
 * (`/ws/browser/:ctx`). Turning `perMessageDeflate` on is therefore not a
 * decision about the bootstrap alone, it is a decision about PTY output and
 * about screencast frames too. Measured with a byte counting TCP proxy in front
 * of a throwaway Bun 1.3.8 server:
 *
 * · `perMessageDeflate: true` on its own compresses NOTHING. `ws.send(x)` went
 *   out at 44,667 B on the wire for a 44,395 B payload; only `ws.send(x, true)`
 *   compressed it, to 5,423 B. The server option negotiates the extension, the
 *   per send flag decides one frame at a time. That flag is what this module
 *   feeds.
 * · On a 30 B payload that same flag cost bytes instead of saving them: 32 B on
 *   the wire raw against 38 B compressed.
 *
 * ## The rules, and what each one is worth
 *
 * · Loopback stays raw, for the reason spelled out in `compress-json.ts`: the
 *   question is "is there a network in between", and for the Tauri shell, the
 *   CLI, the test bench and `relay-client.ts` (which re-plays a guest's frames
 *   over a LOCAL socket on this same machine) there is not.
 * · Under one MTU stays raw. This is the rule that settles the PTY tension on
 *   its own, with no per socket exception: a keystroke echo is 1 B, a cursor
 *   move 7 B, a line of test output 73 B, so the latency critical traffic never
 *   pays a deflate. What IS above the threshold on that socket is a redraw or a
 *   scrollback flush, and those are the most compressible bytes on the whole
 *   server (a 1,927 B full screen redraw gzips to 41 B, 47x).
 * · Screencast frames stay raw whatever their size. They are base64 of JPEG,
 *   which is already compressed: measured on a real 76 KB JPEG, the 101,687 B
 *   frame gzips to 72,341 B (1.41x, and that 1.41x is only the 4/3 that base64
 *   added) for 1.49 ms per frame per viewer. At 20 fps that is 30 ms of CPU per
 *   second per viewer to buy 29%, on a stream that already DROPS frames when
 *   the link is congested (server.ts, `getBufferedAmount() > 1_000_000`). The
 *   bandwidth knob for a screencast is the JPEG quality and the frame rate.
 *   Everything else on that socket (`dom_event` co-browse batches, `console`,
 *   `nav`) is JSON and goes through the size rule like the rest.
 *
 * ## What this module does NOT decide
 *
 * The compressor flavour. `perMessageDeflate: true` negotiates
 * `server_no_context_takeover` (measured in the same probe), so every frame is
 * deflated against an empty window: that is exactly the setting the ratios
 * above were measured under, and it keeps per socket memory near zero, which
 * matters for a shell whose reason to exist is low RAM. `{ compress:
 * "dedicated" }` would keep a window per socket and compress repeated frames
 * better, at 3 KB to 256 KB of RAM per socket. Not taken: the win above is a
 * one shot bootstrap, while a window per socket is a standing cost.
 */

import { MIN_COMPRESS_BYTES } from "./compress-json";

/**
 * One MTU, the same number the HTTP side uses. Imported and re-exported, not
 * re-declared: two thresholds for the same question is one of them going stale.
 */
export { MIN_COMPRESS_BYTES };

/**
 * Frame types whose payload is already compressed, so deflate can only give
 * back what the transport encoding added. Today that is the screencast frame:
 * base64 of a JPEG.
 */
const ALREADY_COMPRESSED = new Set(["frame"]);

/**
 * Should this frame go out compressed?
 *
 * Pure and apart from the sending, because the rules are what has to be proved
 * one by one, and proving them on a live socket would need a live socket.
 *
 * There is deliberately no "which socket is this" argument. The kind of socket
 * changes nothing that `type` and `bytes` do not already say: PTY output has no
 * envelope and no type, and it is the size rule that keeps every keystroke off
 * the compressor.
 */
export function shouldCompressFrame(args: {
  /**
   * The `type` field of the frame, when it is JSON and has one. `null` for raw
   * PTY bytes and for any other binary frame: those are decided by size alone.
   */
  type: string | null;
  /**
   * Bytes of the payload as it would go out uncompressed. A caller that passes
   * `payload.length` instead of the UTF-8 byte count errs on the safe side: for
   * a JS string the byte count is never SMALLER than the length, so the only
   * mistake possible is leaving a borderline frame uncompressed.
   */
  bytes: number;
  /** `false` for loopback: see the note at the top of the file. */
  remote: boolean;
  threshold?: number;
}): boolean {
  if (!args.remote) return false;
  // Already compressed payloads, on any socket: the 1.41x measured on a real
  // screencast frame is the base64 expansion coming back, and it costs 1.49 ms
  // on the live view path.
  if (args.type !== null && ALREADY_COMPRESSED.has(args.type)) return false;
  // Under one packet there is no round trip to save, and on an incompressible
  // short frame deflate ADDS bytes: 32 B on the wire raw against 38 B
  // compressed, measured on a 30 B payload.
  if (args.bytes < (args.threshold ?? MIN_COMPRESS_BYTES)) return false;
  return true;
}
