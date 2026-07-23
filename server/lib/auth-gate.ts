/**
 * auth-gate — the ONE decision point that guards `/api`, `/ws`, and the
 * file-serving paths (`/preview`, `/api/media`) on the :3333 server.
 *
 * Threat model (local-first desktop app that ALSO exposes a mobile/PWA mode by
 * binding the LAN): before this, the whole surface was unauthenticated, so any
 * device on the same network could read/write arbitrary files and drive
 * terminals, and any website the user visited could CSRF the loopback server.
 *
 * Model — deliberately friction-free for the local app, closed to everyone else:
 *   1. Kill-switch: `TOPICS_AUTH_OFF=1` bypasses everything (recovery hatch — if
 *      a bug ever locks the owner out, set it and `kickstart` the server).
 *   2. Transport: LOOPBACK is trusted (the Tauri shell reaches :3333 through its
 *      local :13333 proxy, and desktop web/dev are same-machine) → no token. A
 *      NON-loopback request (a phone, another LAN host) MUST carry the pairing
 *      token (the daemon state-file token, reused). Timing-safe compare.
 *   3. CSRF: a malicious *website* the owner visits issues a same-machine
 *      (loopback) `fetch`, so transport alone can't stop it — but its request
 *      carries a foreign `Origin`. Block any MUTATING request or WS upgrade whose
 *      Origin is present and NOT local (localhost/127.0.0.1/[::1]/*.localhost/
 *      tauri.localhost) and not explicitly allowlisted. The app's own origins are
 *      all local, so this is CSRF defense that (by construction) can't block it.
 *
 * Pure + injected inputs so the whole matrix is unit-tested without a server.
 */
import { timingSafeEqual } from "crypto";

export interface AuthInput {
  /** Remote peer address (server.requestIP(req)?.address). null ⇒ treat as non-loopback (fail closed). */
  ip: string | null;
  /** Origin header, if any. */
  origin: string | null;
  /** HTTP method (WS upgrades arrive as GET). */
  method: string;
  /** Request path — used to detect a WS upgrade (`/ws/...`). */
  pathname: string;
  /** Token the caller presented (header X-Topics-Token / Bearer, or ?token= for WS). */
  token: string | null;
  /** The server's pairing token (state-file token). null/"" ⇒ no remote access possible. */
  expectedToken: string | null;
  /** TOPICS_AUTH_OFF kill-switch. */
  authOff: boolean;
  /** Extra explicitly-allowed origins (beyond the local ones), e.g. a paired PWA host. */
  allowedOrigins?: string[];
}

export type AuthResult = { allow: true } | { allow: false; status: number; reason: string };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The paths the gate protects: the API, WS upgrades, and the two file-serving
 * roots (`/preview/…` absolute-path reads and `/media/…` for ~/.topics/media —
 * agent screenshots, browser downloads, task preview media). Everything else
 * (the SPA bundle, health checks) is public. Kept here next to `evaluateAuth`
 * so "what is gated" and "how the gate decides" can't drift apart, and so both
 * are unit-testable without booting the server.
 */
export function isAuthGatedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ws/") ||
    pathname.startsWith("/preview/") ||
    pathname.startsWith("/media/")
  );
}

/** Loopback in both v4 and v6 shapes (incl. the v4-mapped-v6 form Bun can hand back). */
export function isLoopbackAddress(ip: string | null): boolean {
  if (!ip) return false;
  const a = ip.toLowerCase();
  return (
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a === "localhost" ||
    /^127\./.test(a) ||
    /^::ffff:127\./.test(a)
  );
}

/** True for an Origin whose host is a local one — the app's own origins
 *  (tauri://localhost, http://localhost:13333, http://127.0.0.1:3333, …). */
export function isLocalOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() strips the brackets from an IPv6 host, so compare the bare form too.
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "tauri.localhost" ||
    host.endsWith(".localhost")
  );
}

function tokenMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

/**
 * The single allow/deny decision. Order matters: kill-switch → transport (token
 * for remote) → CSRF (origin for mutating/WS). Returns the HTTP status to send
 * on denial so the caller doesn't re-derive it.
 */
export function evaluateAuth(i: AuthInput): AuthResult {
  if (i.authOff) return { allow: true };

  // Transport: remote peers must present the pairing token; loopback is trusted.
  if (!isLoopbackAddress(i.ip)) {
    if (!tokenMatches(i.token, i.expectedToken)) {
      return { allow: false, status: 401, reason: "pairing token required for remote access" };
    }
  }

  // CSRF: block a mutating request / WS upgrade carrying a foreign Origin.
  const isWsUpgrade = i.pathname.startsWith("/ws/");
  if ((MUTATING.has(i.method) || isWsUpgrade) && i.origin) {
    const allowed = isLocalOrigin(i.origin) || (i.allowedOrigins?.includes(i.origin) ?? false);
    if (!allowed) {
      return { allow: false, status: 403, reason: "cross-site origin blocked" };
    }
  }

  return { allow: true };
}
