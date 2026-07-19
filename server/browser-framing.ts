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
 *
 * SSRF: `probeFraming` fetches a CLIENT-supplied URL server-side, so it MUST
 * refuse private / loopback / link-local / CGNAT targets and cloud-metadata
 * endpoints (169.254.169.254, *.internal). A blocked target resolves to
 * `framable:false` — the safe default (stream), which is also fine UX-wise
 * (internal sites usually forbid framing anyway).
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

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

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || (p.length > 1 && p[0] === '0')) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
}

/** True if an IPv4 literal is in a private / loopback / link-local / reserved /
 *  CGNAT / metadata range — i.e. NOT a safe public SSRF target. */
export function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // private
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local + cloud metadata (169.254.169.254)
    inRange('172.16.0.0', 12) ||    // private
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.168.0.0', 16) ||   // private
    inRange('198.18.0.0', 15) ||    // benchmarking
    inRange('224.0.0.0', 4) ||      // multicast
    inRange('240.0.0.0', 4)         // reserved / broadcast
  );
}

/** True if an IPv6 literal is loopback / ULA / link-local / v4-mapped-private. */
export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (/^f[cd]/.test(lower)) return true;   // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

/**
 * SSRF guard: is `url` safe to fetch server-side? Only http(s), and the host
 * must NOT be (or resolve to) a private/loopback/link-local/reserved address,
 * nor an obvious internal name. `resolver` is injectable for tests.
 */
export async function isSafePublicUrl(
  url: string,
  resolver: (host: string) => Promise<{ address: string; family: number }[]> =
    (host) => lookup(host, { all: true }),
): Promise<boolean> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  const lh = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lh === 'localhost' || lh.endsWith('.local') || lh.endsWith('.internal') || lh === 'metadata.google.internal') {
    return false;
  }
  const fam = isIP(host.replace(/^\[|\]$/g, ''));
  if (fam === 4) return !isPrivateIpv4(lh);
  if (fam === 6) return !isPrivateIpv6(lh);
  // Hostname → resolve; block if ANY resolved address is private (a public name
  // that points at an internal IP is the classic SSRF bypass).
  try {
    const addrs = await resolver(host);
    if (!addrs.length) return false;
    for (const a of addrs) {
      if (a.family === 4 && isPrivateIpv4(a.address)) return false;
      if (a.family === 6 && isPrivateIpv6(a.address)) return false;
    }
    return true;
  } catch {
    return false; // DNS failure → unsafe
  }
}

/**
 * Probe whether `url` can be framed. Only http(s) is framable via this path
 * (about:blank / data:/localhost are decided elsewhere). SSRF-guarded: private/
 * internal targets resolve to `false` without any fetch. Network errors and
 * timeouts also resolve to `false` (stream is the safe fallback). Cached per-URL.
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
    // Follow redirects MANUALLY, validating each hop against the SSRF guard —
    // `redirect:'follow'` would let a public URL 3xx-bounce to an internal
    // address, bypassing the check. Bounded hop count; timeout across all hops.
    const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    let currentUrl = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      if (!(await isSafePublicUrl(currentUrl))) { res = null; break; } // blocked hop
      res = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: deadline,
        headers: { 'User-Agent': PROBE_UA },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try { await res.body?.cancel(); } catch { /* noop */ }
        if (!loc) break; // 3xx without Location — nothing to follow
        currentUrl = new URL(loc, currentUrl).toString();
        res = null;
        continue;
      }
      break; // non-redirect response → use its headers
    }
    if (res) {
      framable = isFramable(res.headers);
      // We only needed the headers — don't download the body.
      try { await res.body?.cancel(); } catch { /* already consumed/closed */ }
    }
  } catch {
    framable = false; // refused / DNS / timeout / blocked → stream is safe
  }
  cache.set(url, { framable, expiresAt: now + FRAMING_TTL_MS });
  return framable;
}

/** Test/maintenance helper: drop the cache. */
export function clearFramingCache(): void {
  cache.clear();
}
