> **RITIRATA il 2026-08-06 — sostituita da `lan-open-same-origin`.**
>
> Il meccanismo descritto qui è stato costruito e funzionava: verificato dal vivo
> il 2026-08-06, una richiesta dalla LAN con l'header `x-topics-token` tornava
> `200` dove senza tornava `401`. Ciò che non è mai esistito è il modo di
> CONSEGNARE quel token a un telefono: nessuna superficie produceva il link di
> pairing, e il token vive in `~/.topics/daemon-state.json`, che dal telefono non
> si legge. L'«Out of scope» qui sotto lo dice senza accorgersene — *«the token is
> captured from whatever link the user already opens»* — ma quel link non lo
> apriva nessuno. Le caselle 5.1 e 5.2 (le uniche verifiche su dispositivo) sono
> rimaste vuote per questo.
>
> La direzione presa è opposta: togliere del tutto l'asse del token e lasciare al
> solo controllo d'origine il compito che nessuna rete può svolgere. Il pairing
> sarà sostituito da un'autenticazione centralizzata che autentica la connessione.
>
> Conservata per la storia. **Non reimplementare quanto descritto qui.**

# Change: lan-pwa-pairing-token

## Why

The auth-gate hardening (S1/S2) shipped **only its server half**, and the result is that the PWA on a phone over the LAN cannot connect at all: it gets **HTTP 401 "pairing token required for remote access"**, and — even once past that — a **403 "cross-site origin blocked"** on every mutating request and WS upgrade.

Two concrete regressions, both in code today:

1. **The client never presents the token.** `client/src/lib/api.ts` fetches `API_BASE='/api'` with only a `Content-Type` header — it never attaches `x-topics-token`. `client/src/hooks/useWebSocket.ts:85` opens `` `${serverWsBase()}/ws` `` with no `?token=` query param, and the Tauri/SSE shim in `client/src/lib/shell/net.ts` (fetch + `EventSource` rewrite) attaches nothing either. So a non-loopback device has no way to authenticate. `server/lib/auth-gate.ts` `evaluateAuth` is explicit: a non-loopback peer that fails `tokenMatches` is a hard `401`. The pairing token exists (`~/.topics/daemon-state.json` → `token`, 64-hex / 32 random bytes, reused as the pairing token) — the client just never reads or sends it.

2. **A valid remote peer is still CSRF-blocked, and `allowedOrigins` is dead.** Even if the phone *did* present the token, `evaluateAuth` runs the CSRF/origin check unconditionally on mutating requests and WS upgrades: the PWA's own origin (`http://192.168.1.12:3333`) is **not local** and **not allowlisted**, so it returns `403 "cross-site origin blocked"`. The gate's `AuthInput.allowedOrigins` field exists but is **never populated** — `server.ts` (~L1289-1314) builds the `evaluateAuth({...})` call without an `allowedOrigins` key, so the allowlist branch (`i.allowedOrigins?.includes(...)`) can never fire. The origin check was designed to stop a *hostile website* CSRF-ing the loopback server; applied to a token-bearing remote peer it just breaks the legitimate PWA.

The fix restores the intended threat model: **loopback trusted, remote peer needs the token, and the token itself IS the CSRF defense** — a hostile website cannot learn a 256-bit pairing token and cannot set a custom `x-topics-token` header cross-origin (that header trips a CORS preflight the server never green-lights). So a request that carries a matching token has already proven it is not a blind cross-site forgery, and the origin check is only meaningful for the token-less loopback path.

## What changes

**Client (the missing half) — one-shot pairing via link, then token on every call:**

- On startup, capture a `?token=…` query param from the launch URL into `localStorage`, then strip it from the address bar via `history.replaceState` so it never lingers in history, bookmarks, or referers. (The user pairs the phone once by opening a link that carries the token.)
- Attach the stored token as an `x-topics-token` request header on **every** `/api` fetch (both the plain web/PWA path in `api.ts` and the Tauri fetch shim in `net.ts`).
- Attach the stored token as a `?token=` query param on the **WS** connection (`useWebSocket.ts` → `${serverWsBase()}/ws`) and on **SSE**/`EventSource` (the shim in `net.ts`) — these can't carry custom headers, so the query-param form the gate already accepts (`url.searchParams.get("token")`) is used.
- Loopback/desktop is unchanged: no token present ⇒ nothing attached ⇒ same trusted path as today.

**Server (finish the wiring):**

- In `evaluateAuth`, once a remote peer presents a **valid** token, **allow** it without applying the foreign-origin CSRF block — the token is the CSRF proof. Keep the origin/CSRF check for the **loopback** path (the token-less local surface a hostile website can still reach).
- Wire `allowedOrigins` through from `server.ts` into the `evaluateAuth({...})` call so the dead field becomes live (for an operator-configured extra origin, e.g. a tunnel host), rather than remaining unreachable.

## Impact

- **Specs (delta)**: `remote-access/` — ADDED `LAN-PAIR-01` (client token capture/strip/attach) and `LAN-PAIR-02` (server: valid remote token bypasses CSRF, `allowedOrigins` wired). No existing requirement is modified (this capability had no auth requirement before).
- **Server**: `server/lib/auth-gate.ts` (`evaluateAuth` decision order — token-valid remote short-circuits the origin check), `server.ts` (~L1289-1314 gate call site now passes `allowedOrigins`), `server/lib/auth-gate.test.ts` (extend the matrix).
- **Client**: `client/src/lib/api.ts` (attach header), `client/src/lib/shell/net.ts` (fetch shim header + `EventSource` token query param + startup capture/strip helper), `client/src/hooks/useWebSocket.ts` (token query param on `/ws`). New small `client/src/lib/shell/pairing.ts` (or equivalent) for capture/store/read.
- **No DB migration.** The pairing token is the existing `daemon-state.json` token; nothing new is persisted server-side.

## Out of scope

- Rotating or provisioning the pairing token, QR-code pairing UX, or a settings panel to display the pairing link — the token is captured from whatever link the user already opens.
- Per-device revocation / multiple tokens — there is one shared pairing token, as today.
- The tunnel/`remote-access` panel behaviour (REMOTE-01) — unchanged.
- The `TOPICS_AUTH_OFF=1` kill-switch — unchanged (still bypasses everything).

## Risks

- **Token leaking via the URL.** A `?token=` in the launch URL can land in history/referer. Mitigation: capture-then-`history.replaceState` strips it on first paint, before any navigation; thereafter the token lives only in `localStorage` and is sent as a header (fetch) or same-origin query param (WS/SSE), never re-placed in the address bar.
- **Weakening CSRF by trusting a token-bearing origin.** A hostile website cannot set `x-topics-token` cross-origin without a CORS preflight the server does not allow, and cannot know a 256-bit token — so "valid token ⇒ skip origin check" does not reopen the CSRF hole the check was built for. The origin check stays exactly as-is on the token-less loopback path (the surface a website *can* reach).
- **`localStorage` unavailable / cleared.** If the token is cleared, the device falls back to today's behaviour (401) and the user re-opens the pairing link. No silent-fail that looks like data loss.
- **Header vs query-param drift.** The gate already reads `x-topics-token`, `Authorization: Bearer`, and `?token=`; the client must use the header form for fetch and the query form only where headers are impossible (WS/SSE). Tests pin both paths.
