/**
 * One stderr line per 5xx answer of the browser bridge that comes from a
 * failure.
 *
 * A WKWebView timeout and a real bug answer the same status, so without the
 * reason in the log nobody can tell them apart. Every such return point of
 * the bridge logs tool, contextId and the same text the response carries.
 * The 503 of a build without the browser service stays quiet: its reason is
 * fixed and already in the body, and it would repeat on every call.
 * The ISO timestamp is in the line itself because the stderr log has none.
 * Eval errors can carry page data, so the reason is cut to one short line.
 */
export function warnBridgeServerError(tool: string, contextId: string, status: number, reason: unknown): void {
  console.warn(`[browser-bridge] ${new Date().toISOString()} ${tool} ${contextId} -> ${status}: ${bridgeReasonLine(reason)}`);
}

const REASON_MAX = 500;

/**
 * The first non-empty line of the reason, with no escape sequence, control or
 * format character left: the page writes eval error messages, and an ESC on
 * stderr is a command to the terminal that shows the log. Besides `\n`, CR,
 * VT, FF, U+0085 and U+2028/U+2029 end a line: a log viewer splits on them,
 * and what follows is page data. A line of zero-width characters only is empty.
 * An Error with nothing in its message falls back to its name; any other
 * empty reason (an HTTP status text can be "") prints as "(empty)".
 */
function bridgeReasonLine(reason: unknown): string {
  const line = reason instanceof Error
    ? firstNonEmptyLine(reason.message) || firstNonEmptyLine(reason.name) || "Error"
    : firstNonEmptyLine(String(reason)) || "(empty)";
  return cutKeepingPairs(line, REASON_MAX);
}

/**
 * ECMA-48 escape sequences, 7-bit and 8-bit: CSI; the control strings OSC,
 * DCS, SOS, PM and APC up to BEL or ST, or up to the next ESC/C1 byte when
 * never closed; the short ESC sequences (ESC 7, ESC ( B). No quantifier can
 * match what the next one matches, so the cost stays linear on any input.
 */
const ESCAPE_SEQUENCE_RE =
  // eslint-disable-next-line no-control-regex -- the control bytes are what this pattern removes
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g;
const LINE_END_RE = /[\n\r\v\f\x85\u2028\u2029]/;
/** Controls left after the sequences are gone (a lone ESC among them) and invisible format characters (ZWSP, BiDi). */
const INVISIBLE_RE = /(?!\t)[\p{Cc}\p{Cf}]/gu;

function firstNonEmptyLine(text: string): string {
  for (const raw of text.replace(ESCAPE_SEQUENCE_RE, "").split(LINE_END_RE)) {
    const line = raw.replace(INVISIBLE_RE, "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

/** `text` cut to `max` UTF-16 units, dropping a high surrogate the cut would leave without its pair. */
function cutKeepingPairs(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
