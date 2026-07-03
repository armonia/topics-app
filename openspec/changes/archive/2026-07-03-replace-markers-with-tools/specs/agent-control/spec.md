# Spec Delta — agent-control

> New capability: how an assistant turn triggers app side-effects. Replaces the
> text-marker control channel with structured tool calls + canonical endpoints.

## ADDED Requirements

### Requirement: AC-01 — Canonical session-keyed control endpoints
The system SHALL expose a fixed set of HTTP control endpoints, each keyed by
`sessionKey`, as the single source of truth for AI- or user-initiated app
side-effects. Each endpoint SHALL wrap the existing side-effect function and emit
the same WebSocket broadcasts as before.

#### Scenario: Bind the current session's topic to a project
- **GIVEN** a session whose `sessionKey` maps to an existing topic
- **WHEN** a client calls `POST /api/sessions/:sessionKey/open-project` with `{ "ref": "project-name-or-slug" }`
- **THEN** the system SHALL resolve the ref against known projects (name/slug, `trustRawPaths:false` — an arbitrary absolute path is refused for the AI path), set the topic's `projectPath`, and persist it
- **AND** SHALL broadcast `topic:updated` and `pane:focus-suggest` so every client nests the session under the project window
- **AND** SHALL return HTTP 200 with the bound project path

> Shipped as `open-project` (not `bind-project`) with a name/slug `ref` rather
> than a raw `projectPath`: the AI path resolves projects Topics already knows
> and refuses arbitrary paths, so an untrusted model can't nest a session under
> `/etc` or `~/.ssh`. A terminal Claude tab (no chat topic) falls back to
> `moveTerminalPaneToProject` on the same endpoint.

#### Scenario: Reject bind to an unknown project
- **GIVEN** a valid session
- **WHEN** `POST .../open-project` is called with a `ref` that resolves to no known project (unknown name, or a raw absolute path under `trustRawPaths:false`)
- **THEN** the system SHALL return HTTP 404 and SHALL NOT change the topic

#### Scenario: Create a project and bind it
- **WHEN** `POST /api/sessions/:sessionKey/create-project` is called with `{ "name": "Foo" }`
- **THEN** the system SHALL scaffold a workspace directory with a `CLAUDE.md` stub, bind the topic to it, and broadcast `topic:updated` + `pane:focus-suggest`
- **AND** SHALL return HTTP 409 if a project with that name already exists

#### Scenario: Switch the active topic
- **WHEN** `POST /api/sessions/:sessionKey/switch-topic` is called with `{ "topicId": "..." }` naming an existing non-archived topic
- **THEN** the system SHALL broadcast `topic:switch` with the from/to ids and target session key
- **AND** SHALL return HTTP 404 if the target topic does not exist, 400 if it is archived

#### Scenario: Create a new topic and switch to it
- **WHEN** `POST /api/sessions/:sessionKey/new-topic` is called with `{ "title": "..." }`
- **THEN** the system SHALL create the topic (inheriting the current `projectPath` if set), broadcast `topic:created` then `topic:switch`
- **AND** SHALL return the new topic id

> Shipped as `new-topic` (not `create-topic`). Endpoint names shipped as
> `open-project` / `create-project` / `switch-topic` / `new-topic`.

#### Scenario: Unknown session
- **WHEN** any control endpoint is called with a `sessionKey` that maps to no topic
- **THEN** the system SHALL return HTTP 404 and perform no side-effect

### Requirement: AC-02 — Tool-based control for capable providers
The system SHALL let the assistant trigger AC-01 side-effects by invoking
structured tools, NOT by emitting text. Tool coverage SHALL be provided per
provider tier.

#### Scenario: CLI provider invokes a control tool via MCP
- **GIVEN** a claude-code session whose MCP bridge is loaded
- **WHEN** the assistant calls the `open_project` tool with a project name/slug ref
- **THEN** the MCP bridge SHALL call `POST /api/sessions/:sessionKey/open-project`
- **AND** the tool SHALL return a short confirmation as its result

> Shipped MCP tools: `open_project` / `create_project` / `switch_topic` /
> `new_topic` / `move_session_to_project` (not `bind_project`). SDK passthrough
> registers the same four topic/project tools via `sendOptions.tools`
> (server/control-tools.ts).

#### Scenario: SDK provider invokes a control tool via passthrough
- **GIVEN** a claude or openai session with control tools registered in `sendOptions.tools`
- **WHEN** the model emits a `tool_use` for a control tool
- **THEN** the server's `onToolStart` dispatch SHALL call the matching AC-01 endpoint and synthesize a confirmation tool result
- **AND** the side-effect SHALL take effect via the normal broadcast even though the result is not fed back in-turn

#### Scenario: Provider without a tool channel degrades to user-driven
- **GIVEN** a provider that cannot receive app tools (e.g. openclaw without gateway support)
- **WHEN** no tool channel is available
- **THEN** the system SHALL NOT emit any text marker and SHALL NOT silently no-op as if it succeeded
- **AND** control SHALL remain available through the user-driven UI (sidebar drag / context-menu / `/project` / `/api/open-project`)
- **AND** the absence of an AI-initiated control channel SHALL be logged at context-assembly time

### Requirement: AC-03 — No text-marker control channel
The system SHALL NOT instruct the model to emit, NOR detect/act upon, any
`{{NAME:body}}` control marker in assistant output.

#### Scenario: System prompt contains no marker instructions
- **WHEN** the context envelope is assembled for any provider
- **THEN** no system block SHALL instruct the model to emit `{{PROJECT_OPEN}}`, `{{PROJECT_CREATE}}`, `{{TOPIC_SWITCH}}`, `{{TOPIC_NEW}}`, or `{{BROWSER}}`

#### Scenario: Marker text in a live stream causes no side-effect
- **GIVEN** the marker control path is removed
- **WHEN** assistant output happens to contain `{{PROJECT_OPEN:...}}` text
- **THEN** the system SHALL perform NO project bind, topic switch, or navigation as a result of that text

### Requirement: AC-04 — Legacy marker scrubbing on read
The system SHALL continue to strip any `{{NAME:body}}` marker from historical
content on the read/replay/display paths so stored transcripts never surface raw
markers in the UI or in provider history.

#### Scenario: Old transcript with a marker is rendered
- **GIVEN** a stored message that contains `{{BROWSER:https://x}}` from before this change
- **WHEN** it is loaded into the client or replayed into provider history
- **THEN** the marker SHALL be stripped from the visible/replayed text
- **AND** no navigation or other side-effect SHALL occur

### Requirement: AC-05 — Move a session/tab into a project (one operation)
The system SHALL provide a SINGLE idempotent operation that relocates a Claude
Code tab (a `terminal` pane) — or any session — into a project window, doing the
full membership move atomically so no caller has to hand-edit `ui_state`.

> Rationale: today this requires ~7 manual steps against raw `ui_state`
> (`projectHash(path)` → read `topics-project-panes-<hash>` → PUT membership →
> open the project window → read the 33 KB app-level `pane-store-v2` → splice the
> standalone pane out of `panes` + `groups.*.paneIds` → PUT it back). That is not
> something an agent (or the UI) should reconstruct by hand; it MUST be one tool.

#### Scenario: Move a Claude Code tab into a project, de-duplicated
- **GIVEN** a `terminal` pane that currently lives standalone in the app-level pane store (`pane-store-v2`)
- **WHEN** the move operation is invoked with the pane/session id and a target project path
- **THEN** the system SHALL add the pane to that project's server-synced membership (`topics-project-panes-<hash>`)
- **AND** SHALL remove the pane from the app-level standalone store (its `panes` entry and every `groups.*.paneIds` reference) in the same operation
- **AND** SHALL open/focus the target project window
- **AND** the result SHALL be exactly ONE instance of the tab, inside the project — never a duplicate inside-and-outside
- **AND** the operation SHALL be idempotent: re-invoking with the same arguments SHALL NOT create duplicates or error

#### Scenario: Split geometry stays device-local
- **GIVEN** the move changes server-synced membership
- **WHEN** clients receive the update
- **THEN** the device-local split/row geometry (`project-layout-<hash>`) SHALL arrange the pane with a sensible default and SHALL NOT be required as input to the operation

#### Scenario: Exposed as a tool, not raw ui_state editing
- **WHEN** an assistant needs to scope its own (or another) session to a project
- **THEN** it SHALL call a single tool (MCP `move_session_to_project` / SDK passthrough equivalent) routed to one canonical endpoint
- **AND** SHALL NOT be expected to compute `projectHash`, read/splice `pane-store-v2`, or issue multiple `ui_state` PUTs

## REMOVED Requirements

### Requirement: Text-marker control channel (decommissioned)
**Reason**: replaced by AC-01..AC-03 (typed tools + canonical endpoints).
**Migration**: side-effect cores are preserved behind the new endpoints; the
emit-instructions (`assemble.ts` marker blocks), live detection
(`detectAndBroadcastBrowserMarker`, `detectAndBroadcastTopicSwitch`,
`detectAndHandleProjectMarkers`), and the per-delta dispatch in `chat.ts` are
deleted. `stripMarkers()` is retained as a read-only legacy guard (AC-04).
