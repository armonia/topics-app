# Delta: remote-access — open LAN access, same-origin as the only gate

## REMOVED Requirements

### Requirement: LAN-PAIR-01 — Client captures the pairing token and presents it on every request

**Reason**: the pairing token is removed entirely. The mechanism worked — a launch
link with `?token=` was captured, stripped, and reattached on every call — but no
surface ever produced that link, and the token lives in
`~/.topics/daemon-state.json`, which a phone cannot read. It will be replaced by a
centralized authentication system that authenticates the connection.

**Migration**: none required client-side. A device that still has a stored token
sends an `x-topics-token` header the server now ignores; the header is harmless and
the storage key becomes inert. `client/src/lib/shell/pairing.ts` and its test are
deleted.

### Requirement: LAN-PAIR-02 — A valid remote pairing token authorizes the peer without the foreign-origin block, and `allowedOrigins` is wired

**Reason**: the transport axis (who may reach the port) is delegated to the network.
Only the origin axis (which page is driving the browser) remains a server decision.
The `allowedOrigins` wiring survives — see `LAN-OPEN-01` — but is no longer a
CSRF-bypass companion to a token.

**Migration**: `evaluateAuth` loses `ip`, `token`, and `expectedToken` from its
input. Callers pass `host` instead. `TOPICS_AUTH_OFF` keeps bypassing everything.

## ADDED Requirements

### Requirement: LAN-OPEN-01 — No token is required from any peer; same-origin is the only gate

The server SHALL NOT require any token, pairing credential, or peer-address property
in order to serve a gated path to a remote peer. The system SHALL treat network
reachability as the transport boundary and SHALL make exactly one authorization
decision per request, on the request's origin.

For a request to a gated path, the server SHALL allow the request when any of the
following holds, evaluated in order: the `TOPICS_AUTH_OFF` kill-switch is set; the
request is neither a mutating method nor a WebSocket upgrade; the request carries no
`Origin` header; the request's `Origin` is same-site with its `Host`; or the
request's `Origin` appears in the operator-configured allowed-origins list. Otherwise
the server SHALL respond `403` with reason `cross-site origin blocked`.

Same-site SHALL be decided on the canonicalized **hostname**, ignoring scheme and
port, with `localhost`, `127.0.0.0/8`, `::1`, and any `*.localhost` name collapsed
into a single local equivalence class. The allowed-origins list SHALL be read from
configuration on every evaluation, without caching, so a changed value takes effect
without a restart.

#### Scenario: A phone on the LAN uses the app with no token
- **GIVEN** a device at a non-loopback address opens the app at `https://<lan-host>:3333`
- **WHEN** it issues any `/api` request, opens the WebSocket, or performs a mutating action
- **AND** it presents no token of any kind
- **THEN** the server SHALL serve the request
- **AND** no response SHALL carry `pairing token required for remote access`

#### Scenario: A hostile website cannot forge a mutating request
- **GIVEN** a page served from an origin whose hostname differs from the server's `Host`
- **WHEN** it issues a mutating request or a WebSocket upgrade to the server
- **THEN** the server SHALL respond `403` with reason `cross-site origin blocked`

#### Scenario: An opaque origin is not same-site
- **GIVEN** a document with an opaque origin (`about:blank`, a sandboxed iframe, a `data:` URL) that sends the literal `Origin: null`
- **WHEN** it issues a mutating request
- **THEN** the server SHALL respond `403`

#### Scenario: A non-browser client without an Origin header is served
- **GIVEN** a client that sends no `Origin` header (the CLI, an MCP tool, an HTTP hook, a `sendBeacon` teardown)
- **WHEN** it issues a mutating request
- **THEN** the server SHALL serve it

#### Scenario: The desktop shell and the dev proxy are same-site
- **GIVEN** the Tauri shell, whose L4 proxy delivers `Origin: tauri://localhost` with `Host: 127.0.0.1:13333`
- **OR** the Vite dev proxy, which rewrites `Host` to the target while leaving `Origin: https://localhost:3332`
- **WHEN** either issues a mutating request
- **THEN** the server SHALL serve it, because both sides canonicalize to the local equivalence class

#### Scenario: Cross-origin reads stay unreadable
- **GIVEN** a page on a foreign origin issues a non-mutating `GET` to a gated path
- **WHEN** the server responds
- **THEN** the response SHALL NOT carry an `Access-Control-Allow-Origin` header for that origin
- **AND** the calling page SHALL therefore be unable to read the body

### Requirement: LAN-OPEN-02 — The daemon control endpoints are loopback-only

The system SHALL restrict the `/__daemon/*` control endpoints to loopback peers, in
addition to the existing bearer-token check, and SHALL compare that token in
constant time. A non-loopback peer SHALL be refused before the token is examined.

#### Scenario: A LAN peer cannot reach the daemon endpoints
- **GIVEN** a request to any `/__daemon/*` path from a non-loopback address
- **WHEN** the server handles it
- **THEN** the server SHALL respond `401` without comparing the presented token

#### Scenario: The local CLI and shell still control the daemon
- **GIVEN** a request from `127.0.0.1` carrying the correct daemon token
- **WHEN** the server handles it
- **THEN** the server SHALL serve it exactly as before

### Requirement: LAN-OPEN-03 — The remote-access panel exposes the tailnet, not the public internet

The system SHALL NOT offer a one-click action that publishes the server to the
public internet. The remote-access panel SHALL expose the server to the operator's
tailnet only, where per-node identity, ACLs, and revocation apply. The tunnel target
SHALL match the server's actual transport, and the active-tunnel detection SHALL read
a key the tunnel provider actually emits.

#### Scenario: No public-internet exposure from the UI
- **GIVEN** the remote-access panel is visible
- **WHEN** the user activates remote access
- **THEN** the system SHALL expose the server to the tailnet only
- **AND** no control in the panel SHALL publish it to the public internet

#### Scenario: The tunnel target matches the server transport
- **GIVEN** the server is listening with TLS
- **WHEN** the system configures the tunnel target
- **THEN** the target SHALL use the HTTPS form, so the tunnel comes up

#### Scenario: Panel status reflects reality
- **GIVEN** remote access has been enabled
- **WHEN** the panel reads tunnel status
- **THEN** it SHALL report active based on a key present in the provider's status output
- **AND** it SHALL report inactive once remote access is disabled

## MODIFIED Requirements

### Requirement: REMOTE-01 — Tunnel Management

The system SHALL provide a remote access panel in the sidebar that displays tunnel
status, allows starting and stopping tailnet exposure, shows the resulting URL with
copy and open-in-browser actions, displays the tunnel provider type with color-coded
labels, shows expiry information, and auto-refreshes status periodically. The panel
SHALL describe the action as exposing the server on the tailnet, and SHALL NOT offer
a public-internet funnel. Any status field rendered as a link SHALL be a URL or
absent — never prose.

#### Scenario: Panel displays inactive tunnel state
- **GIVEN** the remote access panel is visible in the sidebar
- **WHEN** no tunnel is currently active
- **THEN** the panel SHALL display an Unlink icon with "No active tunnel" text
- **AND** a button offering to expose the server on the tailnet SHALL be visible

#### Scenario: User exposes the server on the tailnet
- **GIVEN** no tunnel is currently active
- **WHEN** the user clicks the tailnet exposure button
- **THEN** the system SHALL send a POST request to /api/remote/tunnel with { action: "start" }
- **AND** the button SHALL show a spinning loader while the request is in progress
- **AND** the status SHALL refresh after 1 second

#### Scenario: A provider that reports no URL renders no link
- **GIVEN** a tunnel provider whose status carries no usable URL
- **WHEN** the panel renders
- **THEN** the panel SHALL render no link for that provider
- **AND** SHALL NOT place descriptive prose in an `href`
