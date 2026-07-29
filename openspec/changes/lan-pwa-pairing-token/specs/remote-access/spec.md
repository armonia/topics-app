# Delta: remote-access — LAN/PWA pairing-token authentication

## ADDED Requirements

### Requirement: LAN-PAIR-01 — Client captures the pairing token and presents it on every request

The client SHALL support one-shot pairing of a remote device (phone/PWA over the LAN) via a launch link carrying the pairing token. On startup, before the first authenticated request, the client SHALL capture a `token` query parameter from the launch URL into persistent local storage, then strip that parameter from the address bar via `history.replaceState` while preserving all other query parameters and the hash, so the token does not linger in browser history, bookmarks, or referers. Whenever a pairing token is stored, the client SHALL attach it as an `x-topics-token` request header on every `/api` fetch, and as a `?token=` query parameter on the WebSocket connection and on SSE/`EventSource` streams (which cannot carry request headers). When no pairing token is stored (the loopback/desktop case), the client SHALL attach nothing and behave exactly as today.

#### Scenario: Launch link token is captured and stripped from the URL
- **GIVEN** a remote device opens the app at a URL containing `?token=<pairing-token>` (plus possibly other params and a hash)
- **WHEN** the client starts up
- **THEN** the token SHALL be written to persistent local storage
- **AND** the `token` parameter SHALL be removed from the address bar via `history.replaceState`
- **AND** all other query parameters and the URL hash SHALL be preserved

#### Scenario: Stored token is attached to API fetches as a header
- **GIVEN** a pairing token is stored in local storage
- **WHEN** the client issues any `/api` request
- **THEN** the request SHALL carry an `x-topics-token` header whose value is the stored token

#### Scenario: Stored token is attached to WS and SSE as a query param
- **GIVEN** a pairing token is stored in local storage
- **WHEN** the client opens the primary WebSocket (`/ws`) or an SSE/`EventSource` stream
- **THEN** the connection URL SHALL include a `token=<stored-token>` query parameter (URL-encoded)

#### Scenario: Loopback/desktop attaches nothing
- **GIVEN** no pairing token is stored (the desktop shell / same-machine web, which never received a `?token=` launch param)
- **WHEN** the client issues API, WS, or SSE requests
- **THEN** no `x-topics-token` header and no `token` query parameter SHALL be added
- **AND** the request behaviour SHALL be identical to today's loopback path

#### Scenario: Cleared token falls back to the pairing prompt path, not silent failure
- **GIVEN** the stored pairing token has been cleared from local storage
- **WHEN** a remote device issues an authenticated request
- **THEN** it SHALL be treated as an unpaired remote device (server responds 401)
- **AND** re-opening the pairing link SHALL restore access

### Requirement: LAN-PAIR-02 — A valid remote pairing token authorizes the peer without the foreign-origin block, and `allowedOrigins` is wired

The server auth gate SHALL treat a valid pairing token from a non-loopback peer as sufficient authorization, allowing the request without applying the foreign-origin (CSRF) block — because a token-bearing remote peer has already proven it is not a blind cross-site forgery (a hostile site can neither learn the pairing token nor set the `x-topics-token` header cross-origin). The gate SHALL continue to require a valid pairing token from every non-loopback peer (a missing or wrong token remains `401`). The gate SHALL keep applying the foreign-origin (CSRF) block on the loopback path only, where a token-less request from a website the owner visits can still reach the server. The server SHALL populate the gate's `allowedOrigins` input from configuration at the call site so that the allowlist branch is reachable (it was previously never passed and therefore dead).

#### Scenario: Token-authed remote peer with a foreign origin is allowed (mutating)
- **GIVEN** a non-loopback peer (a PWA on `http://192.168.1.12:3333`) presenting a valid pairing token
- **WHEN** it issues a mutating request (POST/PUT/PATCH/DELETE) whose `Origin` is neither local nor allowlisted
- **THEN** the gate SHALL allow the request (no `403 "cross-site origin blocked"`)

#### Scenario: Token-authed remote peer with a foreign origin is allowed (WS upgrade)
- **GIVEN** a non-loopback peer presenting a valid pairing token
- **WHEN** it opens a WebSocket upgrade whose `Origin` is neither local nor allowlisted
- **THEN** the gate SHALL allow the upgrade

#### Scenario: Remote peer without a valid token is still rejected
- **GIVEN** a non-loopback peer with a missing or incorrect pairing token
- **WHEN** it issues any gated request
- **THEN** the gate SHALL respond `401` with reason "pairing token required for remote access"

#### Scenario: Loopback CSRF defense is unchanged
- **GIVEN** a loopback (same-machine) request carrying a foreign, non-local, non-allowlisted `Origin`
- **WHEN** it is a mutating request or a WS upgrade
- **THEN** the gate SHALL respond `403 "cross-site origin blocked"` (unchanged from today)

#### Scenario: Configured allowlisted origin is honoured on the loopback path
- **GIVEN** the server is configured with an extra allowed origin and passes it into the gate
- **WHEN** a loopback mutating request carries that exact `Origin`
- **THEN** the gate SHALL allow it (the previously-dead `allowedOrigins` branch is now reachable)

#### Scenario: Kill-switch still bypasses everything
- **GIVEN** `TOPICS_AUTH_OFF=1`
- **WHEN** any request reaches the gate
- **THEN** the gate SHALL allow it regardless of transport, token, or origin
