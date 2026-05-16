## ADDED Requirements

### Requirement: Context envelope is the canonical context representation

The system SHALL define a `ContextEnvelope` data structure as the single canonical representation of a topic's context (system blocks, chat history, and current user turn). All paths that read or send the topic context — chat streaming, inspector preview, snapshot diagnostics — SHALL derive their data from the same `assembleTopicContext()` function. No code path SHALL reconstruct system blocks or chat history independently.

A `ContextEnvelope` SHALL contain:
1. `systemBlocks[]` — ordered list of system content blocks with stable id, label, category, content, tokens, enabled flag, countInBudget flag, editable flag, optional sourceUri.
2. `history[]` — chat messages already filtered through `stripMarkers()`, `isContextMessage` filter, partial filter, and `historyLimit`.
3. `userMessage` — current/next user turn content + optional storedMessageId.
4. `providerName` and `providerStrategy` — which provider this envelope is shaped for.
5. `diagnostics` — totalTokens, budgetLimit, budgetPercent, droppedHistoryTurns, per-message HistoryEntryDiagnostic with strippedMarkers and excludeReason, warnings, assembledAt.

#### Scenario: Provider streaming uses canonical envelope
- **GIVEN** a user posts a message to `/api/topics/:id/message`
- **WHEN** the route handler prepares the payload for `provider.sendChat`
- **THEN** the handler SHALL call `assembleTopicContext()` to produce a `ContextEnvelope`
- **AND** SHALL call `adaptEnvelope(envelope)` to produce the `ProviderPayload`
- **AND** SHALL pass `payload.userContent`, `payload.history`, and `payload.options` to `sendChat`
- **AND** SHALL NOT construct `finalMessages`, `ephemeralSystems`, or inline `<context>` preambles independently in the route handler

#### Scenario: Inspector reads same envelope as the streaming path
- **GIVEN** the same topic, the same DB state, the same file system state
- **WHEN** the streaming path assembles its envelope
- **AND** the inspector path assembles its envelope (via `/api/topics/:id/context-preview`)
- **THEN** the two envelopes SHALL be identical except for fields that legitimately differ (`assembledAt` timestamp, `userMessage` if a different turn is being previewed, `includeLastUserInHistory` flag)

### Requirement: Provider declares context strategy

Each provider SHALL declare a `contextStrategy` field of type `ProviderContextStrategy` enum: `"history-aware" | "inline-system" | "gateway-stateful"`. This field replaces ad-hoc `if (capabilities.has("history"))` branching at the route layer.

- `history-aware` — provider receives `system` messages and prior turns via the `history` field (Anthropic SDK, OpenAI, codex).
- `inline-system` — provider does not receive `history`; system blocks SHALL be inlined into the user turn as a `<context>...</context>` preamble (claude-code).
- `gateway-stateful` — provider may use its own session state but SHALL also accept `history` as a fallback for restart rehydration (openclaw gateway).

If a provider does not declare `contextStrategy`, the system SHALL fall back to `"history-aware"` if `capabilities.has("history")`, else `"inline-system"`.

#### Scenario: claude-code provider declares inline-system strategy
- **WHEN** the claude-code provider is registered
- **THEN** its `contextStrategy` SHALL equal `"inline-system"`
- **AND** `adaptEnvelope` for an envelope with this strategy SHALL produce `payload.userContent` starting with `<context>` when ≥1 system block is enabled
- **AND** `payload.history` SHALL be undefined

#### Scenario: claude provider declares history-aware strategy
- **WHEN** the claude provider is registered
- **THEN** its `contextStrategy` SHALL equal `"history-aware"`
- **AND** `adaptEnvelope` SHALL produce `payload.history` containing all enabled system blocks as `{role: "system"}` messages followed by the envelope history
- **AND** `payload.userContent` SHALL equal `envelope.userMessage.content` without any preamble

#### Scenario: openclaw provider declares gateway-stateful strategy
- **WHEN** the openclaw provider is registered
- **THEN** its `contextStrategy` SHALL equal `"gateway-stateful"`
- **AND** `adaptEnvelope` SHALL produce `payload.history` (for rehydrate fallback) but `payload.adaptationNotes` SHALL document that the gateway may ignore it

### Requirement: Sent envelopes are captured in a per-topic ring buffer

Immediately before each `provider.sendChat` invocation, the system SHALL push the assembled `ContextEnvelope` into an in-memory ring buffer keyed by `topicId`. The ring SHALL hold the 5 most recent envelopes per topic; older entries SHALL be evicted FIFO.

The ring SHALL be exposed via `GET /api/topics/:id/context-snapshots` returning `{ snapshots: ContextEnvelope[] }` in chronological order (oldest first).

The ring SHALL be clearable via `DELETE /api/topics/:id/context-snapshots`.

The ring is in-memory only — it SHALL NOT be persisted to disk and SHALL be empty after server restart.

#### Scenario: Sending a message records a snapshot
- **GIVEN** a topic has 0 snapshots
- **WHEN** a user posts one message and the provider streaming completes
- **THEN** `getSnapshots(topicId)` SHALL return exactly 1 envelope
- **AND** the envelope's `userMessage.content` SHALL equal the user's posted text
- **AND** the envelope's `providerName` SHALL equal the topic's current provider

#### Scenario: Ring evicts oldest beyond capacity
- **GIVEN** a topic has 5 snapshots
- **WHEN** the user posts a 6th message and the provider streaming starts
- **THEN** `getSnapshots(topicId)` SHALL return 5 envelopes
- **AND** the previously-oldest snapshot SHALL no longer be present
- **AND** the just-pushed snapshot SHALL be the last in the array

#### Scenario: Snapshots are isolated per topic
- **GIVEN** topic A has 3 snapshots and topic B has 2
- **WHEN** `getSnapshots(A)` and `getSnapshots(B)` are called
- **THEN** they SHALL return 3 and 2 envelopes respectively, with no cross-contamination

### Requirement: Provider history reconstruction is deterministic across paths

The DB-derived chat history SHALL be the source of truth across server restarts and client reconnects. Both `assembleTopicContext` (canonical path) and any legacy callers SHALL produce identical history arrays for the same `(sessionKey, historyLimit, includeLastUserInHistory)` inputs by delegating to a single `buildProviderHistory()` utility.

Marker stripping (`{{BROWSER:...}}`, `{{TOPIC_SWITCH:...}}`, `{{TOPIC_NEW:...}}`), `isContextMessage` filtering, partial-message filtering, and limit-based truncation SHALL all happen in `buildProviderHistory()` only — never duplicated in route handlers or the inspector.

#### Scenario: History reconstruction is consistent
- **GIVEN** the DB contains 150 user/assistant messages for a session
- **AND** the third message contains `{{BROWSER:open}}`
- **WHEN** `assembleTopicContext` is called with `historyLimit=100`
- **THEN** the returned `envelope.history` SHALL contain exactly 100 messages
- **AND** the third message's content SHALL NOT contain `{{BROWSER:open}}`
- **AND** `envelope.diagnostics.droppedHistoryTurns` SHALL equal 50
- **AND** `envelope.diagnostics.historyEntries[2].strippedMarkers` SHALL include `{{BROWSER:open}}`
