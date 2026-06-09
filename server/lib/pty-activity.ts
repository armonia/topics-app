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

// ───────────────────────────────────────────────────────────────────────────
// Input-echo suppression
// ───────────────────────────────────────────────────────────────────────────
//
// classifyFrame stops an ANIMATED statusline from pinning a session busy, but
// it cannot tell a frame produced by the PROCESS (Claude streaming a token)
// from a frame produced by the USER typing — both change the visible text. When
// you type into a Claude Code prompt, the TUI echoes/redraws the input line,
// which classifyFrame sees as "real activity", so the loading spinner lights up
// for nothing — and worse, a typed char can revive a `dormant` session back to
// `running` (reviveOnPtyActivity fires on every non-cosmetic frame). That's the
// "basta che scrivo nell'input e parte il loading" bug.
//
// The missing bit of information is: did the user just send input to this pty?
// The server forwards every keystroke to the bridge as a `write`, so it can
// stamp the time of the last input per session. An output frame that arrives
// within a short window of that input is overwhelmingly that input's echo — or
// an input-triggered redraw (an autocomplete / file-mention menu, prompt
// reflow) — NOT the process doing work, so it must not mark the session busy or
// revive it.
//
// Why a time window and not a content match: Claude Code redraws the WHOLE
// input line on each keystroke (cursor moves + the line's glyphs), so the echo
// frame's visible text is "> hello", not the bare typed char — a byte-for-byte
// content match would miss it, and would also miss menus/reflow. Arrival time
// relative to the keystroke is the robust, content-agnostic signal.
//
// The window is comfortably larger than keystroke→echo latency (a few tens of
// ms on localhost, with headroom for a loaded event loop) yet small enough that
// genuine streamed output — which lasts seconds — is at most marginally
// delayed, never hidden: only a response that both STARTS and FINISHES within
// the window is missed, i.e. a sub-150ms burst (a trivial instant shell
// command; a real LLM turn's first-token latency always exceeds it). For hooked
// Claude Code sessions the phase machine (UserPromptSubmit→running on Enter) is
// the authoritative "working" signal and drives the spinner regardless of this
// gate, so suppressing the first frames after input hides no real work there.
// Kept tight (not larger) so typing WHILE a bare session streams suppresses as
// few real frames as possible.
export const INPUT_ECHO_WINDOW_MS = 150;

/**
 * True when an output frame should be treated as the echo of — or a redraw
 * triggered by — the user's own recent input, rather than process activity.
 *
 * @param msSinceInput elapsed ms since this session's last keystroke, or null
 *        when the session has no recorded input (then it is never echo).
 * @param windowMs the echo window; defaults to INPUT_ECHO_WINDOW_MS.
 */
export function isInputEcho(
  msSinceInput: number | null,
  windowMs: number = INPUT_ECHO_WINDOW_MS,
): boolean {
  return msSinceInput !== null && msSinceInput >= 0 && msSinceInput < windowMs;
}
