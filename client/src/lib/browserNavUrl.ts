/**
 * Resolve a URL before handing it to a browser pane.
 *
 * Background — the white-screen bug: when a Claude session opens a freshly
 * started dev server (e.g. `open_browser_pane("http://localhost:3000")`), the
 * server broadcasts `browser:navigate`. The standalone layout used to rewrite
 * ANY localhost/127.0.0.1 URL to `window.location.hostname` AND force
 * `window.location.protocol` (https in the desktop app). On the Electron
 * desktop — where the WebContentsView runs on the SAME machine as the server —
 * that turned a reachable `http://localhost:3000` into an unreachable
 * `https://127.0.0.1:3000`, so Chromium showed `chrome-error://…` (a blank
 * white page). That is exactly the "apre il browser e si apre bianco" report.
 *
 * The rewrite only makes sense for a REMOTE web client (Tailscale / LAN): there
 * the client's browser genuinely cannot reach the server's localhost, so local
 * URLs are repointed at the host the client actually used. In every local case
 * (Electron desktop, or a web client served from localhost) the original URL is
 * directly reachable and must be left untouched — including its scheme.
 */
export function resolveBrowserNavigateUrl(raw: string): string {
  if (typeof window === 'undefined') return raw;

  const here = window.location.hostname;
  // Local web client (same machine as the server): localhost reachable too.
  if (!here || here === 'localhost' || here === '127.0.0.1') return raw;

  // Remote web client: repoint local URLs at the reachable host so the
  // iframe/stream can load them. Mirrors the long-standing remote behaviour.
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = here;
      parsed.protocol = window.location.protocol;
      return parsed.toString();
    }
  } catch {
    /* not a parseable URL — leave as-is */
  }
  return raw;
}
