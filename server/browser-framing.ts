/**
 * Framing probe for the web browser pane's iframe-vs-stream decision (T2).
 *
 * The web client renders a URL as a real sandboxed <iframe> (native fidelity,
 * no lag) when the target ALLOWS being framed, and falls back to the server-side
 * screenshot stream when it does not (Google, banks, most login pages) or when
 * an agent needs to drive the page. This module answers "can this URL be framed?"
 * by reading the target's `X-Frame-Options` and CSP `frame-ancestors` — done
 * server-side (no CORS), cached per-URL.
 *
 * `isFramable` is pure (unit-tested); `probeFraming` adds the network fetch + cache.
 */

const FRAMING_TTL_MS = 5 * 60 * 1000; // per-URL cache (per-path: framing varies by path)
const PROBE_TIMEOUT_MS = 3000;
const PROBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

interface CacheEntry { framable: boolean; expiresAt: number }
const cache = new Map<string, CacheEntry>();

/** Header-lookup shape shared by fetch's Headers and a plain test object. */
export type HeaderGetter = { get(name: string): string | null };

/**
 * Decide framability from response headers. Conservative: anything that
 * restricts framing to specific origins is treated as NOT framable, because a
 * third-party origin (us) is almost never on such an allowlist. Only the
 * absence of a restriction (or an explicit `*`) counts as framable.
 */
export function isFramable(headers: HeaderGetter): boolean {
  const xfo = headers.get('x-frame-options');
  if (xfo) {
    const v = xfo.toLowerCase();
    // DENY, SAMEORIGIN, and the (deprecated, unreliable) ALLOW-FROM all mean we
    // can't reliably frame it from a different origin.
    if (v.includes('deny') || v.includes('sameorigin') || v.includes('allow-from')) return false;
  }
  const csp = headers.get('content-security-policy');
  if (csp) {
    const m = csp.match(/frame-ancestors([^;]*)/i);
    if (m) {
      const val = m[1].trim().toLowerCase();
      if (val === '' || val.includes("'none'")) return false; // frame-ancestors 'none' (or empty) = blocked
      if (!val.includes('*')) return false; // a specific allowlist without a wildcard → assume we're not on it
    }
  }
  return true;
}

/**
 * Probe whether `url` can be framed. Only http(s) is framable via this path
 * (about:blank / data:/localhost are decided elsewhere). Network errors and
 * timeouts resolve to `false` (stream is the safe fallback). Cached per-URL.
 */
export async function probeFraming(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.framable;

  let framable = false;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': PROBE_UA },
    });
    framable = isFramable(res.headers);
    // We only needed the headers — don't download the body.
    try { await res.body?.cancel(); } catch { /* already consumed/closed */ }
  } catch {
    framable = false; // refused / DNS / timeout → stream is safe
  }
  cache.set(url, { framable, expiresAt: now + FRAMING_TTL_MS });
  return framable;
}

/** Test/maintenance helper: drop the cache. */
export function clearFramingCache(): void {
  cache.clear();
}
