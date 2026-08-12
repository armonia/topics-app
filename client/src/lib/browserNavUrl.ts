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

/**
 * Best-effort URL/search normalisation for the address bar.
 *
 * Full URLs (any `scheme://…`) and `about:` pass through untouched; a bare host
 * (`github.com`) gets `https://`; anything else (spaces, or no dot) becomes a
 * Google search. Shared by the address-bar submit (`BrowserToolbar`) and the
 * native hook's `navigate()` so the two agree.
 *
 * The bug this closes: the toolbar's submit used to force `http://` onto ANY
 * scheme-less text, which (a) shadowed the search fallback — typing "come fare
 * la pasta" navigated to `http://come fare la pasta` (a broken load) instead of
 * searching — and (b) downgraded bare hosts to `http://` where a browser
 * defaults to `https://`.
 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  // looks like a domain (has a dot, no spaces) → https://
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(' ')) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
