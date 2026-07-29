# Tasks: lan-pwa-pairing-token

Each task lists its verification. The change is complete only when every box is checked and the auth-gate suite plus the client pairing tests pass. Work on a branch off `main`.

## 1. Server — gate decision order (LAN-PAIR-02)

- [ ] 1.1 Restructure `evaluateAuth` (`server/lib/auth-gate.ts`): on the non-loopback branch, a valid `tokenMatches` SHALL `return { allow: true }` (skip the foreign-origin block); a missing/wrong token stays `401`. Move the origin/CSRF check to the loopback-only path with identical semantics (still honours `isLocalOrigin` OR `allowedOrigins`). **Verify:** `bun:test` — new cases: remote+valid-token+foreign-origin+POST ⇒ allow; remote+valid-token+WS+foreign-origin ⇒ allow; remote+no-token ⇒ 401.
- [ ] 1.2 Preserve loopback behaviour byte-for-byte: loopback+foreign-origin+POST ⇒ 403; loopback+`authOff` ⇒ allow; existing cases unchanged. **Verify:** `bun:test` — the pre-existing matrix in `auth-gate.test.ts` still green.
- [ ] 1.3 Wire `allowedOrigins` at the call site (`server.ts` ~L1289-1314): add `allowedOrigins: resolveAllowedOrigins()` to the `evaluateAuth({...})` object, sourced from env/config (cached reader), empty by default. **Verify:** integration — with the env set, a loopback request carrying that origin is allowed; with it unset, behaviour is today's.
- [ ] 1.4 Extend `server/lib/auth-gate.test.ts` to cover the allowlisted-origin-on-loopback case and the full new matrix from `design.md §3`. **Verify:** suite green, every row asserted.

## 2. Client — pairing token capture & storage (LAN-PAIR-01)

- [ ] 2.1 New `client/src/lib/shell/pairing.ts`: `capturePairingTokenFromUrl()` (read `?token=`, persist to `localStorage['topics.pairingToken']`, strip via `history.replaceState` preserving other params + hash, idempotent, no-op when absent) and `getPairingToken(): string | null`. **Verify:** unit test — capture strips only `token`, preserves other query params and hash; `getPairingToken` round-trips; both no-op when nothing is stored.
- [ ] 2.2 Call `capturePairingTokenFromUrl()` once at startup, before the first fetch/WS open (next to `installDesktopFetchShim()`), so the first authenticated call carries the token and the bar is clean on first paint. **Verify:** startup order test / manual — the token is stored and stripped before any `/api` request fires.

## 3. Client — attach on fetch (LAN-PAIR-01)

- [ ] 3.1 `client/src/lib/api.ts` `request()`: merge `x-topics-token: <token>` into headers when `getPairingToken()` is non-null; attach nothing otherwise. **Verify:** unit test — a fetch spy sees the header with a stored token, and no header without one.
- [ ] 3.2 `client/src/lib/shell/net.ts` `installDesktopFetchShim`: inject the same header in the global fetch rewrite (inert on desktop/loopback where the token is null, kept for symmetry). **Verify:** unit test on the shim wrapper.

## 4. Client — attach on WS + SSE (LAN-PAIR-01)

- [ ] 4.1 `client/src/hooks/useWebSocket.ts:85`: append `?token=<encoded token>` to `` `${serverWsBase()}/ws` `` when a token is stored; bare `/ws` otherwise. **Verify:** unit test — WS URL gains the param only when a token exists.
- [ ] 4.2 `client/src/lib/shell/net.ts` `EventSource` path (`DesktopEventSource` + the web/PWA construction): append `?token=<encoded token>` to gated stream URLs when a token is stored. **Verify:** unit test — SSE URL gains the param only when a token exists.

## 5. End-to-end + close-out

- [ ] 5.1 E2E / manual over LAN: a phone opens the pairing link (`http://<lan-ip>:3333/?token=<daemon token>`), the URL is stripped to `http://<lan-ip>:3333/`, and the PWA loads, streams over WS, and performs a mutating action — no 401, no 403. **Verify:** durable evidence (screen recording or logs showing 200s on `/api` + WS connected).
- [ ] 5.2 Regression: desktop shell (Tauri, loopback via `:13333`) still works with no token attached anywhere. **Verify:** desktop smoke — API/WS/SSE all connect; no `x-topics-token` header sent.
- [ ] 5.3 Full `bun:test` (auth-gate) + client pairing unit suite + typecheck green. **Verify:** command output.
