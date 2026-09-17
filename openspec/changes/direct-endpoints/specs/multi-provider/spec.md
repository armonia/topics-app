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

### Requirement: MP-DIRECT-04 — A configured endpoint is a chat connection, never a task runtime

A configured endpoint SHALL be offered wherever a chat connection is chosen, and SHALL NOT be offered as a task runtime or as a task model, in keeping with MP-TASK-01. It reaches the endpoint in a single round trip, with no file or bash tool and no way to update a task, so a card handed to one could never be closed. A model of a configured endpoint SHALL stay out of the task pickers even when its name resembles a coding model.

#### Scenario: The endpoint is selectable for a chat
- **WHEN** an endpoint is configured and ready
- **THEN** the chat provider picker offers it.

#### Scenario: The same endpoint is absent from the task pickers
- **WHEN** the task runtime and task model options are built from the same snapshot
- **THEN** neither offers the endpoint nor any of its models
- **AND** a provider that really can run tasks is still offered.

### Requirement: MP-DIRECT-05 — A provider name that survives being parsed

The provider name of a configured endpoint SHALL be derived from its identifier with a fixed prefix and SHALL NOT contain a colon, because a task model is stored as `provider:model` and a colon in the provider half would split at the wrong place. A declared context window SHALL be ignored when it is not a positive finite number, so a damaged configuration shows the known-model guess rather than nonsense.

#### Scenario: The name carries no separator
- **WHEN** a provider name is built for an endpoint
- **THEN** it is recognisable as a configured endpoint and contains no colon.

#### Scenario: A damaged declared window is not displayed
- **WHEN** an endpoint declares a window that is zero, negative or not a number
- **THEN** the window shown falls back to the static table instead of the declared value.
