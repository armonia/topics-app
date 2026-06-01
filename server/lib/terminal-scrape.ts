/**
 * terminal-scrape — pull the Master's `## Next` block out of a raw PTY buffer.
 *
 * The Master is an interactive `claude` PTY (see interactive-claude-primitive,
 * AD-2/AD-3). Its output is rendered terminal text — ANSI escapes, cursor moves,
 * line wrapping — not clean stream-json. To turn the human-driven reply into
 * kanban cards we read the scrollback (`requestBuffer`), strip the terminal
 * noise here, and hand the cleaned text to `parseNextActions`.
 *
 * Pure + side-effect-free → unit-testable with `bun:test`. Reading already-on-
 * screen text is NOT a model call, so this stays on the subscription (the model
 * spoke only because the human pressed Enter).
 */

// All escapes use explicit \x.. codes so no literal control bytes live in the
// source (those get mangled by editors/transports).
//
// OSC: ESC ] ... (BEL | ESC \) — window-title etc.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI: ESC [ ... final-byte (SGR colors, cursor moves, erase, etc.)
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Other short ESC sequences: charset select ESC(B, keypad ESC= ESC>, ESC7/8/M/c.
const ESC_SEQ_RE = /\x1b[()#][0-9A-Za-z]|\x1b[=>78Mc]/g;
// Stray control chars except \n (\x0a) and \t (\x09).
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Remove ANSI escape sequences and stray control chars from raw PTY text. */
export function stripAnsi(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC_SEQ_RE, "")
    .replace(/\r/g, "") // CR from CRLF / cursor returns
    .replace(CTRL_RE, "");
}

/**
 * Extract the body of the LAST `## Next` (or `### Next` / `## Next action`)
 * block in a terminal buffer. We take the last occurrence because the
 * scrollback accumulates every turn and we want the most recent proposal set.
 * Returns "" if no block is present. Input may be raw (we strip ANSI first).
 *
 * The returned text still contains the bullet rows; `parseNextActions` does the
 * row-level parsing. The block ends at the next markdown heading.
 */
export function extractLatestNextBlock(rawOrClean: string): string {
  const text = stripAnsi(rawOrClean);
  if (!text) return "";

  const headingRe = /^[ \t]*#{2,3}[ \t]*Next(?:[ \t]+action)?[ \t]*$/gim;
  let lastStart = -1;
  let lastHeaderLen = 0;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    lastStart = m.index;
    lastHeaderLen = m[0].length;
  }
  if (lastStart === -1) return "";

  const rest = text.slice(lastStart + lastHeaderLen);
  const stop = rest.match(/^[ \t]*#{1,6}[ \t]+\S/m);
  const body = (stop ? rest.slice(0, stop.index) : rest).trim();
  return body;
}
