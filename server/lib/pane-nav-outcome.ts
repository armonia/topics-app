/**
 * Did the pane ACTUALLY get there?
 *
 * `open_browser_pane` answers with a URL, and for a long time that URL was the
 * one it had been ASKED for. When the navigation silently failed - a local file
 * ref resolved against an origin with no server behind it, a dev server that
 * was not listening - the webview stayed on `about:blank` and the tool still
 * said "Opened browser pane at <url>". The agent believed it had handed a page
 * to whoever asked and moved on; the screen was white. Nothing on the outside
 * could catch it: the native pane records no console and no network.
 *
 * So the answer is compared with the address the view reports for itself. A
 * blank view after a real request is not a page: it is a failure with no error
 * attached, and this is the sentence that attaches one.
 */

/**
 * The URL to ANNOUNCE and RECORD, given what was asked and where the view is.
 *
 * A local file is deliberately requested as a RELATIVE reference,
 * `/api/media?path=…`, so the tab keeps working when the host changes (the
 * desktop shell's proxy, the TLS server, the address a phone on the LAN uses).
 * The view can only answer in absolute form, so taking its word literally would
 * pin the tab to whichever origin this one client happened to use - the tab is
 * a durable record, and that origin is not.
 *
 * So: same document, keep the reference; anywhere else (a genuine redirect),
 * the view is right and the request is stale.
 */
export function settledUrl(requested: string, reached: string): string {
  if (!reached) return requested;
  if (!requested.startsWith("/")) return reached;
  try {
    const u = new URL(reached);
    return `${u.pathname}${u.search}` === requested ? requested : reached;
  } catch {
    return reached;
  }
}

/** The addresses that mean "this view is showing nothing". */
const BLANK = new Set(["", "about:blank", "about:srcdoc", "about:newtab"]);

function isBlank(url: string): boolean {
  return BLANK.has(url.trim().toLowerCase());
}

/**
 * The failure sentence when the pane never left the blank page, `null` when
 * there is nothing to complain about.
 *
 * Asking for a blank page and getting one is not a failure, so `requested`
 * being blank ends the question. A `reached` this function cannot read (an
 * empty string from a view that answered nothing) counts as blank: a view that
 * cannot even say where it is has not loaded a page either.
 */
export function blankPaneFailure(requested: string, reached: string): string | null {
  if (isBlank(requested)) return null;
  if (!isBlank(reached)) return null;
  return (
    `the pane is still on ${reached || "about:blank"}: "${requested}" never loaded. ` +
    `Nothing was shown to the user. A local file must be served over /api/media ` +
    `(the file:// scheme cannot be rendered here), and a local port must be listening.`
  );
}
