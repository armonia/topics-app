/**
 * Pure helpers for deciding whether a pty output frame represents real activity
 * or just a cosmetic repaint.
 *
 * Why this exists: terminal "busy" (the loading spinner / project rollup) is
 * derived from pty output — a session is busy while bytes flow, idle after a
 * quiet window. But a TUI can repaint continuously WITHOUT doing any work: the
 * Claude Code statusline animates a "breathing" colour on the "◎ /goal active"
 * badge, emitting a ~73-byte frame every ~200ms forever. Those frames are
 * identical except for an SGR colour code, so the raw-byte heuristic keeps the
 * session pinned "busy" indefinitely and its project tab spins even though
 * Claude is idle.
 *
 * The fix: compare the VISIBLE text of each frame (ANSI colour + cursor
 * sequences stripped). If the visible content is unchanged from the previous
 * frame — or there's no visible content at all — it's a cosmetic repaint and
 * must not count as activity. Real work (streamed tokens, a ticking elapsed
 * counter, a rotating spinner glyph) changes the visible text and still marks
 * busy. This also makes the active→idle "finished" signal fire correctly,
 * which an always-animating statusline used to suppress.
 *
 * No IO, no state — deterministic and unit-testable.
 */

// CSI sequences: ESC [ params intermediates final  (covers colour `m`, cursor
// moves H/f/A-G, erases J/K, show/hide cursor ?25l/h, etc.)
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// OSC sequences: ESC ] ... terminated by BEL or ST (ESC \)
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Other 2-byte ESC sequences (charset selection, etc.)
const ESC2 = /\x1b[@-Z\\-_]/g;

/**
 * Reduce a raw pty frame to its visible text: ANSI escape sequences and
 * carriage returns removed, trailing whitespace per line trimmed. Two frames
 * with the same signature paint the same characters on screen.
 */
export function visibleSignature(data: string): string {
  return data
    .replace(CSI, '')
    .replace(OSC, '')
    .replace(ESC2, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export interface FrameClassification {
  /** True when the frame is a cosmetic-only repaint (no visible change). */
  cosmetic: boolean;
  /** The signature to carry forward as the new "previous" (unchanged on a
   *  no-visible-content frame so an empty paint doesn't erase real history). */
  sig: string;
}

/**
 * Classify a frame against the previous visible signature for its session.
 *
 *   - empty visible content        → cosmetic, keep the previous signature
 *   - same visible text as before  → cosmetic (animation / cursor wiggle)
 *   - changed visible text         → real activity, adopt the new signature
 */
export function classifyFrame(prevSig: string | undefined, data: string): FrameClassification {
  const sig = visibleSignature(data);
  if (sig === '') return { cosmetic: true, sig: prevSig ?? '' };
  if (sig === prevSig) return { cosmetic: true, sig };
  return { cosmetic: false, sig };
}
