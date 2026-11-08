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

/** What a reason that cannot become text prints as, in the line and in the body. */
const UNPRINTABLE = "(unprintable)";

/**
 * The text of a thrown value for the body of a 5xx: an Error gives its
 * message ("" when it has none), anything else its `String()`.
 * It never throws. It runs inside the catch that sends the answer, and a throw
 * there leaves the request with no answer at all. Page code can throw anything:
 * an object with no prototype, a revoked Proxy, an Error whose message is a
 * BigInt or a getter that throws.
 */
export function bridgeErrorText(reason: unknown): string {
  const error = asError(reason);
  if (error) return fieldText(error, "message") ?? "";
  return textOf(reason) ?? UNPRINTABLE;
}

/**
 * The first non-empty line of the reason, with no escape sequence, control or
 * format character left: the page writes eval error messages, and an ESC on
 * stderr is a command to the terminal that shows the log. Besides `\n`, CR,
 * VT, FF, U+0085 and U+2028/U+2029 end a line: a log viewer splits on them,
 * and what follows is page data. A line of format characters only (ZWSP,
 * BiDi marks) is empty.
 * An Error with nothing readable in its message falls back to its name, then
 * to "Error"; any other empty reason (an HTTP status text can be "") prints as
 * "(empty)", and one with no text at all as "(unprintable)". Like
 * `bridgeErrorText`, it never throws.
 */
function bridgeReasonLine(reason: unknown): string {
  const error = asError(reason);
  let line: string;
  if (error) {
    line = firstNonEmptyLine(fieldText(error, "message") ?? "") || firstNonEmptyLine(fieldText(error, "name") ?? "") || "Error";
  } else {
    const text = textOf(reason);
    line = text === null ? UNPRINTABLE : firstNonEmptyLine(text) || "(empty)";
  }
  return cutKeepingPairs(line, REASON_MAX);
}

/** The reason as an Error, or null. `instanceof` itself throws on a revoked Proxy. */
function asError(reason: unknown): Error | null {
  try {
    return reason instanceof Error ? reason : null;
  } catch {
    return null;
  }
}

/** `String(value)`, or null when that throws (no prototype, a throwing `toString`, a revoked Proxy). */
function textOf(value: unknown): string | null {
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** A field of the error as text; null when it is missing (null, undefined), its getter throws, or it cannot become text. */
function fieldText(error: Error, key: "message" | "name"): string | null {
  let value: unknown;
  try {
    value = error[key];
  } catch {
    return null;
  }
  return value == null ? null : textOf(value);
}

/**
 * ECMA-48 escape sequences, 7-bit and 8-bit: CSI; the control strings OSC,
 * DCS, SOS, PM and APC up to BEL or ST, or up to the next ESC/C1 byte or
 * line end when never closed (a lone C1 byte from mojibake then costs the
 * rest of its line, not the reason on the next one); the short ESC sequences (ESC 7, ESC ( B). No quantifier can
 * match what the next one matches, so the cost stays linear on any input.
 */
const ESCAPE_SEQUENCE_RE =
  // eslint-disable-next-line no-control-regex -- the control bytes are what this pattern removes
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x80-\x9f\n\r\v\f\u2028\u2029]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g;
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
