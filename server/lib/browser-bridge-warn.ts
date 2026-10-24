import { stripAnsi } from "../utils/path-env";

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
 * The first non-empty line of the reason, without ANSI escapes or control
 * bytes. U+2028/U+2029 end a line like `\n` does: a log viewer splits on them,
 * and what follows them is as much page data as what follows a newline. An
 * Error with nothing in its message falls back to its name; any other empty
 * reason (an HTTP status text can be "") prints as "(empty)".
 */
function bridgeReasonLine(reason: unknown): string {
  const line = reason instanceof Error
    ? firstNonEmptyLine(reason.message) || firstNonEmptyLine(reason.name) || "Error"
    : firstNonEmptyLine(String(reason)) || "(empty)";
  return cutKeepingPairs(line, REASON_MAX);
}

function firstNonEmptyLine(text: string): string {
  return stripAnsi(text).split(/[\n\u2028\u2029]/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** `text` cut to `max` UTF-16 units, dropping a high surrogate the cut would leave without its pair. */
function cutKeepingPairs(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
