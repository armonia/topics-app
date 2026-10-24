/**
 * One stderr line per 5xx answer of the browser bridge.
 *
 * A WKWebView timeout and a real bug answer the same status, so without the
 * reason in the log nobody can tell them apart. Every 5xx return point of
 * the bridge logs tool, contextId and the same text the response carries.
 * The ISO timestamp is in the line itself because the stderr log has none.
 * Eval errors can carry page data, so the reason is cut to one short line.
 */
export function warnBridgeServerError(tool: string, contextId: string, status: number, reason: unknown): void {
  const text = reason instanceof Error ? reason.message : String(reason);
  const oneLine = text.split("\n")[0].replace(/\r/g, "").slice(0, 500);
  console.warn(`[browser-bridge] ${new Date().toISOString()} ${tool} ${contextId} -> ${status}: ${oneLine}`);
}
