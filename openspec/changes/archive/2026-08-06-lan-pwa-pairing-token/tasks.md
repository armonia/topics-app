# Tasks: lan-pwa-pairing-token

Each task lists its verification. The change is complete only when every box is checked and the auth-gate suite plus the client pairing tests pass. Work on a branch off `main`.

## 1. Server — gate decision order (LAN-PAIR-02)

- [x] 1.1 Restructure `evaluateAuth` (`server/lib/auth-gate.ts`): on the non-loopback branch, a valid `tokenMatches` SHALL `return { allow: true }` (skip the foreign-origin block); a missing/wrong token stays `401`. Move the origin/CSRF check to the loopback-only path with identical semantics (still honours `isLocalOrigin` OR `allowedOrigins`). **Verify:** `bun:test` — new cases: remote+valid-token+foreign-origin+POST ⇒ allow; remote+valid-token+WS+foreign-origin ⇒ allow; remote+no-token ⇒ 401.
- [x] 1.2 Preserve loopback behaviour byte-for-byte: loopback+foreign-origin+POST ⇒ 403; loopback+`authOff` ⇒ allow; existing cases unchanged. **Verify:** `bun:test` — the pre-existing matrix in `auth-gate.test.ts` still green.
- [x] 1.3 Wire `allowedOrigins` at the call site (`server.ts` ~L1289-1314): add `allowedOrigins: resolveAllowedOrigins()` to the `evaluateAuth({...})` object, sourced from env/config (cached reader), empty by default. **Verify:** integration — with the env set, a loopback request carrying that origin is allowed; with it unset, behaviour is today's.
- [x] 1.4 Extend `server/lib/auth-gate.test.ts` to cover the allowlisted-origin-on-loopback case and the full new matrix from `design.md §3`. **Verify:** suite green, every row asserted.

## 2. Client — pairing token capture & storage (LAN-PAIR-01)

- [x] 2.1 New `client/src/lib/shell/pairing.ts`: `capturePairingTokenFromUrl()` (read `?token=`, persist to `localStorage['topics.pairingToken']`, strip via `history.replaceState` preserving other params + hash, idempotent, no-op when absent) and `getPairingToken(): string | null`. **Verify:** unit test — capture strips only `token`, preserves other query params and hash; `getPairingToken` round-trips; both no-op when nothing is stored.
- [x] 2.2 Call `capturePairingTokenFromUrl()` once at startup, before the first fetch/WS open (next to `installNetShim()`), so the first authenticated call carries the token and the bar is clean on first paint. **Verify:** startup order test / manual — the token is stored and stripped before any `/api` request fires.

## 3. Client — attach on fetch (LAN-PAIR-01)

- [x] 3.1 `client/src/lib/api.ts` `request()`: merge `x-topics-token: <token>` into headers when `getPairingToken()` is non-null; attach nothing otherwise. **Verify:** unit test — a fetch spy sees the header with a stored token, and no header without one.
- [x] 3.2 `client/src/lib/shell/net.ts` `installNetShim`: inject the same header in the global fetch rewrite (inert on desktop/loopback where the token is null, kept for symmetry). **Verify:** unit test on the shim wrapper.

## 4. Client — attach on WS + SSE (LAN-PAIR-01)

- [x] 4.1 `client/src/hooks/useWebSocket.ts:85`: append `?token=<encoded token>` to `` `${serverWsBase()}/ws` `` when a token is stored; bare `/ws` otherwise. **Verify:** unit test — WS URL gains the param only when a token exists.
- [x] 4.2 `client/src/lib/shell/net.ts` `EventSource` path (`ShimmedEventSource` + the web/PWA construction): append `?token=<encoded token>` to gated stream URLs when a token is stored. **Verify:** unit test — SSE URL gains the param only when a token exists.

## 5. End-to-end + close-out

- [ ] 5.1 E2E / manual over LAN: a phone opens the pairing link (`http://<lan-ip>:3333/?token=<daemon token>`), the URL is stripped to `http://<lan-ip>:3333/`, and the PWA loads, streams over WS, and performs a mutating action — no 401, no 403. **Verify:** durable evidence (screen recording or logs showing 200s on `/api` + WS connected).
- [ ] 5.2 Regression: desktop shell (Tauri, loopback via `:13333`) still works with no token attached anywhere. **Verify:** desktop smoke — API/WS/SSE all connect; no `x-topics-token` header sent.
- [x] 5.3 Full `bun:test` (auth-gate) + client pairing unit suite + typecheck green. **Verify:** command output.

## Note di chiusura (2026-07-30)

**Buco trovato consegnando, e chiuso.** Il piano attaccava il token in due posti,
`api.ts::request` e lo shim globale, e dava lo shim per gated su Tauri (task 3.2
diceva "inert on desktop/loopback … kept for symmetry"). Ma nel client ci sono
~80 chiamate `fetch('/api/…')`, 46 mutanti, in oltre 20 file, e le più calde —
sync del pane-store, dei tombstone, del layout di progetto, delle tab del browser
del task — usano `fetch` NUDO con header propri (`X-Client-Id`, `keepalive`) e non
passano da `api.ts`. Con lo shim gated su `!isTauri → esci`, sulla PWA in LAN
(l'unico caso in cui un token esiste) nessuna di quelle chiamate lo portava: 401
sul percorso più caldo che c'è. Il fix sta nel choke point — lo shim si installa
anche fuori da Tauri quando un token è memorizzato — non nei 46 callsite, e
`net.test.ts` fissa il gate sui due lati.

**Cosa resta, e perché non è spuntato.** 5.1 e 5.2 chiedono verifiche su
DISPOSITIVI: un telefono in LAN che apre il link di pairing, e uno smoke del
guscio Tauri. Non sono verificabili da qui e non vanno spuntate a fiducia. Il
codice è a posto e coperto dagli unit test (matrice auth-gate + helper di pairing
+ gate dello shim); manca la prova su hardware, che è esattamente ciò che quelle
due caselle chiedono. La change resta APERTA per questo: non è documentazione da
archiviare, è una prova da raccogliere.
