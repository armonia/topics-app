/**
 * The live output of the tools still running, kept where the catch-up can read it.
 *
 * `stream:tool_update` was broadcast and forgotten: nothing wrote it anywhere,
 * because the database row is written by the turn's throttle and a running
 * shell can print four tails a second. The catch-up a socket gets when it opens
 * (a reconnect, a pane mounting, a reload) is built from that row, so every
 * reopen showed the running shell with no output at all, until the next line it
 * printed, and for good when the command was silent from then on. Measured on
 * 04/10: three lines on screen, zero after the catch-up.
 *
 * So the last tail of each running tool stays in memory on the turn's registry
 * entry (`ActiveStream.liveToolTails`), capped like the native shell's own
 * buffer, never written to disk, and dropped as soon as the tool has its result:
 * from then on the row carries the real output.
 */
import type { ActiveStream } from "../types";

/** How much of a running tool's output is kept: the LAST 16 KB, in bytes, the cap of the native shell's own tail (`LIVE_TAIL_BYTES`, providers/native/tools.ts). */
export const LIVE_TOOL_TAIL_BYTES = 16 * 1024;

/** The tail cut to its last `LIVE_TOOL_TAIL_BYTES`, starting on a whole character. */
export function capLiveToolTail(tail: string): string {
  const bytes = Buffer.from(tail, "utf8");
  if (bytes.length <= LIVE_TOOL_TAIL_BYTES) return tail;
  let from = bytes.length - LIVE_TOOL_TAIL_BYTES;
  // Skip UTF-8 continuation bytes: a cut inside a character would decode to U+FFFD.
  while (from < bytes.length && (bytes[from]! & 0xc0) === 0x80) from++;
  return bytes.subarray(from).toString("utf8");
}

/** Keeps the latest tail of `toolCallId` on the stream entry. Every call carries the whole current tail, so it replaces. */
export function rememberLiveToolTail(stream: Pick<ActiveStream, "liveToolTails"> | undefined, toolCallId: string, tail: string): void {
  if (!stream) return;
  (stream.liveToolTails ??= new Map()).set(toolCallId, capLiveToolTail(tail));
}

/** The tool has its result: its tail is no longer what the row shows. */
export function forgetLiveToolTail(stream: Pick<ActiveStream, "liveToolTails"> | undefined, toolCallId: string): void {
  stream?.liveToolTails?.delete(toolCallId);
}
