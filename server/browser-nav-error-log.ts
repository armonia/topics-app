/**
 * THE SERVER'S RECORD OF A NAVIGATION ERROR THE STRIP SHOWED.
 *
 * The Playwright engine's failures already land in this log (`[BrowserService]
 * Navigate warning for …` in browser-service.ts), because they happen ON the
 * server. A native pane's failures (WKWebView, codes -1200…-1206 in
 * navErrorMessage.ts) happen on the Mac and never crossed back: a card could
 * show a TLS strip and the server log had nothing about it (task 590a3979,
 * 22/11). This module is the one line that closes that gap — pure, so the
 * format is a unit test and not a read of the live log file.
 */

export interface NavErrorLogEntry {
  /** Which pane/context reported it (NSErrorFailingURLStringKey's pane, not the URL's host). */
  paneId: string;
  /** host[:port] the navigation was going to, or the raw URL when it does not parse. */
  host: string;
  /** NSURLErrorDomain / WebKitErrorDomain code. */
  code: number;
  /** WebKit's own `localizedDescription`. */
  description: string;
  /** Epoch ms the pane took the failure at. */
  at: number;
}

/** `16:03` — the clock a human reads, from an epoch ms the wire sent. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * One line, everything a diagnosis needs: pane, host, code, WebKit's words, time.
 *
 * `[BrowserService]` prefix matches every other line in this log so a grep for
 * it (or for "nav error") finds this one too.
 */
export function formatNavErrorLogLine(e: NavErrorLogEntry): string {
  return `[BrowserService] native nav error on ${e.paneId} → ${e.host} (code ${e.code}) at ${clockTime(e.at)}: ${e.description}`;
}

export function logNavError(e: NavErrorLogEntry, sink: (line: string) => void = console.warn): void {
  sink(formatNavErrorLogLine(e));
}
