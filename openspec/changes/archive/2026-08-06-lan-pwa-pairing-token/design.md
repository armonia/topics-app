# Design: lan-pwa-pairing-token

## Guiding constraints

- **The gate is the one decision point** (`server/lib/auth-gate.ts` `evaluateAuth`, called once in `server.ts` ~L1289-1314 for every `isAuthGatedPath`). This change adds **no new gate** and no new endpoint — it corrects the decision order in the existing pure function and finally sends, from the client, the credential the gate already knows how to read.
- **Loopback pays nothing, ever.** The desktop shell reaches `:3333` via its own `:13333` loopback proxy, so it stays on the trusted, token-less, no-op path. Every change here fires only on the non-loopback branch.
- **The pairing token is the existing `daemon-state.json` token** (`~/.topics/daemon-state.json` → `token`, 32 random bytes / 64 hex). No new secret, no new persistence, no rotation in scope. `server.ts` already reads it via `readState()?.token` on the remote branch.
- **The gate already accepts three credential forms** (`x-topics-token` header, `Authorization: Bearer`, `?token=` query). The client must use the **header** form wherever headers are possible (fetch) and the **query** form only where they are not (WS upgrade, `EventSource`). No new credential channel is invented.

---

## 1. Server — decision order in `evaluateAuth`

### 1.1 Today (the bug)

```ts
export function evaluateAuth(i: AuthInput): AuthResult {
  if (i.authOff) return { allow: true };

  // Transport: remote peers must present the pairing token; loopback is trusted.
  if (!isLoopbackAddress(i.ip)) {
    if (!tokenMatches(i.token, i.expectedToken)) {
      return { allow: false, status: 401, reason: "pairing token required for remote access" };
    }
  }

  // CSRF: block a mutating request / WS upgrade carrying a foreign Origin.
  const isWsUpgrade = isWebSocketPath(i.pathname);
  if ((MUTATING.has(i.method) || isWsUpgrade) && i.origin) {
    const allowed = isLocalOrigin(i.origin) || (i.allowedOrigins?.includes(i.origin) ?? false);
    if (!allowed) {
      return { allow: false, status: 403, reason: "cross-site origin blocked" };
    }
  }

  return { allow: true };
}
```

The CSRF block runs **after** and **independently of** the token check — so a remote peer that passed the token check (a PWA on `http://192.168.1.12:3333`) is still 403'd on every mutating request / WS upgrade because its origin is neither local nor in the (always-empty) `allowedOrigins`.

### 1.2 Fix — a valid remote token short-circuits the origin check

The threat the origin check defends is a **hostile website CSRF-ing the loopback server**. That attacker rides the owner's loopback trust and therefore presents **no token** (it can't know the 256-bit value, and can't set the `x-topics-token` header cross-origin without a preflight the server refuses). So the origin check is only meaningful on the **token-less** path. Restructure:

```ts
export function evaluateAuth(i: AuthInput): AuthResult {
  if (i.authOff) return { allow: true };

  const remote = !isLoopbackAddress(i.ip);
  if (remote) {
    // Remote peers must present the pairing token …
    if (!tokenMatches(i.token, i.expectedToken)) {
      return { allow: false, status: 401, reason: "pairing token required for remote access" };
    }
    // … and a valid token IS the CSRF proof (a hostile site can neither learn a
    // 256-bit token nor set x-topics-token cross-origin), so a token-authed
    // remote peer is allowed without the foreign-origin block.
    return { allow: true };
  }

  // Loopback path only: a website the owner visits can fetch the loopback server
  // WITHOUT a token, so the origin/CSRF check stays here.
  const isWsUpgrade = isWebSocketPath(i.pathname);
  if ((MUTATING.has(i.method) || isWsUpgrade) && i.origin) {
    const allowed = isLocalOrigin(i.origin) || (i.allowedOrigins?.includes(i.origin) ?? false);
    if (!allowed) {
      return { allow: false, status: 403, reason: "cross-site origin blocked" };
    }
  }

  return { allow: true };
}
```

Notes:
- Behaviour on the **loopback** path is byte-for-byte unchanged (same origin check, same `allowedOrigins` OR-branch). So `TOPICS_AUTH_OFF`, desktop, dev, and the "website CSRFs loopback → 403" scenarios all keep passing.
- `allowedOrigins` stays in the loopback branch — it is the operator escape hatch for an extra *local-ish* origin. Wiring it from `server.ts` (below) is what makes it non-dead; the semantics are unchanged.
- Ordering matters and is now explicit: **kill-switch → (remote? token → allow) → (loopback CSRF)**.

### 1.3 Wire `allowedOrigins` from `server.ts`

The call site (~L1289-1314) builds `evaluateAuth({ ip, origin, method, pathname, token, expectedToken, authOff })` with **no** `allowedOrigins` key. Add it, sourced from configuration/env (e.g. a comma-split env var, resolved once), so the field the gate reads is actually populated:

```ts
const decision = evaluateAuth({
  ip, origin: req.headers.get("origin"), method, pathname,
  token: loopback ? null : (/* header | bearer | ?token= — unchanged */),
  expectedToken: loopback ? null : readState()?.token ?? null,
  authOff: process.env.TOPICS_AUTH_OFF === "1",
  allowedOrigins: resolveAllowedOrigins(), // NEW — was never passed
});
```

`resolveAllowedOrigins()` is a thin, cached reader (env/config); empty by default (today's effective behaviour), so nothing regresses when unset.

---

## 2. Client — one-shot pairing capture, then attach on every call

### 2.1 Where the token lives

A small module (e.g. `client/src/lib/shell/pairing.ts`):
- `capturePairingTokenFromUrl()` — read `?token=` from `window.location`; if present, write it to `localStorage['topics.pairingToken']` and **strip it** from the URL via `history.replaceState(null, '', urlWithoutToken)` (preserve every other query param + hash). Idempotent; no-op when absent.
- `getPairingToken(): string | null` — read from `localStorage`; returns `null` on desktop/loopback (nothing was ever captured) so the attach helpers become no-ops.

Called once at startup, **before** the first fetch / WS open (alongside `installDesktopFetchShim()`), so the very first authenticated call already carries the token and the bar is clean on first paint.

### 2.2 Fetch — `x-topics-token` header

- **Web/PWA path** (`client/src/lib/api.ts` `request()`): merge `x-topics-token: <token>` into `headers` when a token exists. One place; every `topicsApi.*`/etc. call inherits it.
- **Tauri shim path** (`client/src/lib/shell/net.ts` `installDesktopFetchShim`): the global `window.fetch` rewrite also injects the header. (Desktop is loopback so `getPairingToken()` is `null` and this is inert — but keeping the injection in the shim keeps the two fetch entry points symmetric and future-proof.)

The header form is deliberate: a custom request header on a cross-origin fetch forces a CORS **preflight**, which the server does not green-light for a hostile site — so only same-origin (the paired PWA itself) can send it. That is exactly why the token-as-header doubles as the CSRF proof in §1.2.

### 2.3 WS + SSE — `?token=` query param

Neither a `WebSocket` nor an `EventSource` can set request headers, so they use the query form the gate already reads (`url.searchParams.get("token")`):

- **WS** (`client/src/hooks/useWebSocket.ts:85`): `new WebSocket(\`${serverWsBase()}/ws\`)` → append `?token=<token>` when present (URL-encoded). Loopback: no token ⇒ bare `/ws`, unchanged.
- **SSE** (`client/src/lib/shell/net.ts` `DesktopEventSource` + the web/PWA `EventSource` construction path): append `?token=<token>` to the stream URL when present. The gate treats `/api/**` stream endpoints as gated, so remote SSE needs it.

### 2.4 What does NOT change

- Desktop/Tauri: `getPairingToken()` is `null` (no launch `?token=`), so every attach is a no-op; the `:13333` loopback proxy path is byte-identical to today.
- No change to `API_BASE`, to `serverHttpBase()`/`serverWsBase()`, or to any call site signature — the token is threaded through the two shared entry points (fetch `request()`/shim, WS/SSE constructors) only.

---

## 3. Test matrix (extends `server/lib/auth-gate.test.ts`)

New `evaluateAuth` cases:
- remote + valid token + **foreign** origin + `POST` ⇒ `allow` (the regression: was 403, now 200).
- remote + valid token + WS upgrade + foreign origin ⇒ `allow`.
- remote + **no/wrong** token ⇒ `401` (unchanged).
- loopback + foreign origin + `POST` ⇒ `403` (unchanged — the CSRF defense still stands where it matters).
- loopback + foreign origin in `allowedOrigins` + `POST` ⇒ `allow` (proves the now-wired field).
- `authOff` ⇒ `allow` regardless (unchanged).

Client (unit): capture strips `?token=` and preserves other params/hash; `getPairingToken` round-trips; fetch attaches the header only when a token exists; WS/SSE URL gains `?token=` only when a token exists.

---

## 4. Rollout / recovery

- Zero-config for desktop (no token path exercised). The phone pairs by opening one link carrying `?token=<daemon token>`.
- Recovery hatch unchanged: `TOPICS_AUTH_OFF=1` + `kickstart` bypasses the whole gate if anything locks the owner out.
