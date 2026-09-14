## Requirements

### Requirement: MP-DIRECT-01 — Configurable OpenAI-compatible chat endpoints

Settings SHALL let a user declare OpenAI-compatible HTTP endpoints with a label, a base URL, an authentication mode of none or bearer, an optional model allow-list and an optional request timeout. Each saved endpoint SHALL register as a chat provider named `direct-<slug>` and SHALL be selectable for chats alongside the built-in providers. Endpoints SHALL persist in a state file written atomically, outside the database and outside any migration. A bearer secret SHALL be stored in a private file of its own, readable only by the account running the server, and SHALL never appear in settings responses, provider snapshots or logs. A malformed or unreadable store SHALL degrade to no configured endpoints without blocking server boot. Deleting an endpoint SHALL remove its provider, its secret and its selection from chats that used it.

Configurable endpoints SHALL NOT appear in the task pickers of the board, whose runtimes must be coding-capable.

#### Scenario: Declare, use and remove an endpoint
- **WHEN** a user adds an endpoint in Settings, tests it, and selects it in a chat
- **THEN** the chat streams from that endpoint and the endpoint survives a server restart
- **AND** after deletion the provider disappears from the chat picker and its secret file entry is gone.

#### Scenario: The board never offers a direct endpoint
- **WHEN** a configured endpoint exists and a task model picker is opened
- **THEN** no `direct-` provider is listed.

### Requirement: MP-DIRECT-02 — Private-network reachability with a guarded URL

Requests to a configured endpoint SHALL be allowed to reach loopback, RFC1918, carrier-grade NAT `100.64.0.0/10` and unique local IPv6 addresses, and SHALL be refused for link-local `169.254.0.0/16`, `fe80::/10`, `0.0.0.0/8` and multicast destinations, for schemes other than http and https, and for URLs carrying user information. The destination SHALL be resolved and re-checked on every request rather than only when saved, and every redirect hop SHALL be checked again before it is followed. A refused destination SHALL surface as a clear endpoint error and SHALL NOT be reported as a model failure.

#### Scenario: Metadata address refused, LAN address allowed
- **WHEN** an endpoint resolves to a cloud metadata address, directly or after a redirect
- **THEN** the request is refused before any body is sent
- **AND** an endpoint resolving to a private or Tailscale address is allowed.

### Requirement: MP-DIRECT-03 — Per-model context window from the endpoint

The provider snapshot SHALL carry a per-model context window for configurable endpoints, taken from the endpoint configuration and from the endpoint's model listing when it reports one. The model picker and the context assembler SHALL prefer that value over the static model table. When an endpoint refuses a request because the context was exceeded, the chat SHALL show a message naming the model and its window rather than the raw upstream error.

#### Scenario: A local 200k model is not shown with the fallback window
- **WHEN** an endpoint reports a context window for its model
- **THEN** the picker badge and the context budget use that window
- **AND** a context-exceeded refusal is shown as a readable explanation.
