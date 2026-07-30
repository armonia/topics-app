// LAN/PWA pairing token (LAN-PAIR-01).
//
// A remote device (phone/PWA over the LAN) pairs ONCE by opening a launch link
// carrying the daemon pairing token as a `?token=` query param. On startup the
// client captures that token into localStorage and strips it from the address
// bar (history.replaceState) so it never lingers in history, bookmarks, or
// referers. Thereafter the token is attached as an `x-topics-token` header on
// every `/api` fetch and as a `?token=` query param on WS/SSE connections (which
// cannot carry request headers).
//
// Loopback/desktop never received a launch `?token=`, so getPairingToken() is
// null there and every attach helper is a no-op — the trusted local path is
// byte-identical to before.

const STORAGE_KEY = 'topics.pairingToken';

/** Read the stored pairing token, or null (desktop/loopback, or never paired,
 *  or storage unavailable/cleared — in which case attach helpers no-op and a
 *  remote device falls back to the 401 pairing-prompt path, never a silent fail). */
export function getPairingToken(): string | null {
  try {
    const t = window.localStorage.getItem(STORAGE_KEY);
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * One-shot capture at startup: if the launch URL carries `?token=…`, persist it
 * and strip ONLY that param from the address bar (preserving every other query
 * param and the hash) via history.replaceState. Idempotent; no-op when absent.
 * Must run BEFORE the first fetch/WS open so the first authenticated call
 * already carries the token and the bar is clean on first paint.
 */
export function capturePairingTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  const token = url.searchParams.get('token');
  if (!token) return;

  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable: leave the token in the URL rather than dropping it
    // silently; nothing to strip because we couldn't persist it.
    return;
  }

  // Strip only `token`; keep all other params + the hash intact.
  url.searchParams.delete('token');
  const stripped = url.pathname + (url.search ? url.search : '') + (url.hash ? url.hash : '');
  try {
    window.history.replaceState(null, '', stripped);
  } catch {
    // replaceState can throw in exotic sandboxes; the token is already stored,
    // so leaving the URL as-is is the safe fallback.
  }
}

/** Merge the `x-topics-token` header into a HeadersInit when a token is stored;
 *  return the headers unchanged otherwise (loopback/desktop → no-op). */
export function withTokenHeader(headers: HeadersInit | undefined): HeadersInit | undefined {
  const token = getPairingToken();
  if (!token) return headers;
  const merged = new Headers(headers);
  merged.set('x-topics-token', token);
  return merged;
}

/** Append `?token=<encoded>` to a URL string when a token is stored; return the
 *  URL unchanged otherwise. Used for WS/SSE, which cannot carry headers. */
export function withTokenQuery(rawUrl: string): string {
  const token = getPairingToken();
  if (!token) return rawUrl;
  const sep = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${sep}token=${encodeURIComponent(token)}`;
}
