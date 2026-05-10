## ADDED Requirements

### Requirement: Inspector preview reflects the canonical envelope

The Context Inspector SHALL provide a preview endpoint `GET /api/topics/:id/context-preview?provider=<name>` that returns `{ envelope: ContextEnvelope, payload: ProviderPayload }`.

The `envelope` SHALL be produced by the same `assembleTopicContext()` function used by the chat streaming path, with `includeLastUserInHistory: true` so the inspector shows the next message that would be sent if the user posted now.

The `payload` SHALL be produced by `adaptEnvelope(envelope)` so the inspector shows the actual `userContent` and `history` shape per provider strategy.

The `provider` query parameter SHALL be optional; when omitted, the topic's current provider is used.

#### Scenario: Preview returns envelope and adapted payload
- **GIVEN** a topic with system prompt, 1 context file, and 5 prior turns in history
- **WHEN** the client calls `GET /api/topics/:id/context-preview`
- **THEN** the response SHALL include `envelope.systemBlocks` containing at least the system prompt and the context file
- **AND** the response SHALL include `envelope.history` with up to 5 turns (post-strip)
- **AND** the response SHALL include `payload` with `userContent` and (for history-aware providers) `history`

#### Scenario: Preview adapts to provider override
- **GIVEN** a topic currently using provider `claude` (history-aware)
- **WHEN** the client calls `GET /api/topics/:id/context-preview?provider=claude-code`
- **THEN** `envelope.providerStrategy` SHALL equal `"inline-system"`
- **AND** `payload.userContent` SHALL begin with `<context>` when ≥1 system block is enabled
- **AND** `payload.history` SHALL be undefined

### Requirement: Inspector exposes history diagnostics

The Context Inspector UI SHALL display, for each topic:
1. A **Provider** indicator showing the current provider name and its `contextStrategy`.
2. A **History** section showing:
   - The count of historic turns included in `envelope.history`.
   - The count of dropped turns from `envelope.diagnostics.droppedHistoryTurns`.
   - For each historic turn, the markers stripped from its content (when any).
3. An **Adaptation notes** section listing `payload.adaptationNotes` strings.

Existing inspector sections (system blocks list, budget bar, source toggles, memory CRUD) SHALL remain unchanged in placement and behavior. New sections SHALL appear alongside or below existing sections without removing any.

#### Scenario: History section reflects truncation
- **GIVEN** a topic has 150 messages and `historyLimit` is 100
- **WHEN** the user opens the inspector
- **THEN** the History section SHALL display "100 turns included, 50 dropped (limit)"

#### Scenario: Stripped markers are visible
- **GIVEN** a turn's original content was `{{BROWSER:open}} hello`
- **WHEN** the user expands that turn in the History section
- **THEN** the section SHALL show the stripped marker `{{BROWSER:open}}` as a separate visual indicator
- **AND** the displayed content SHALL show what the model actually receives (`hello`)

#### Scenario: Adaptation notes show inlining for claude-code
- **GIVEN** a topic uses provider `claude-code` with 7 enabled system blocks
- **WHEN** the inspector loads
- **THEN** an Adaptation Notes section SHALL display a note containing "7 system block(s) inlined into user turn"
- **AND** a note SHALL clarify that history is not sent (`Provider does NOT receive history field`)

### Requirement: Inspector exposes a Last-Sent snapshots view

The Context Inspector UI SHALL provide a "Last sent" view that lists the snapshots returned by `GET /api/topics/:id/context-snapshots`. For each snapshot the view SHALL display:
1. The `assembledAt` timestamp (relative format, e.g. "3 minutes ago").
2. The user message that triggered that send (`envelope.userMessage.content`, truncated).
3. A summary line: number of system blocks, history turns, total tokens.
4. An action to expand and view the full envelope JSON for diagnostics.

The view SHALL include a clear-snapshots action calling `DELETE /api/topics/:id/context-snapshots` with confirmation.

If the snapshots list is empty (e.g., no messages sent since server start), the view SHALL display a friendly empty state explaining the snapshots are in-memory and reset on server restart.

#### Scenario: Last-sent shows previous sends
- **GIVEN** the user has sent 3 messages on this topic since the server started
- **WHEN** the user opens the Last Sent view
- **THEN** 3 snapshot entries SHALL be visible
- **AND** the first entry's user message SHALL match the oldest of the 3 sent

#### Scenario: Last-sent reflects ring eviction
- **GIVEN** the user has sent 7 messages
- **WHEN** the user opens the Last Sent view
- **THEN** exactly 5 snapshot entries SHALL be visible
- **AND** the oldest 2 messages SHALL NOT appear

#### Scenario: Empty snapshots show explanatory state
- **GIVEN** the server was just restarted and no messages have been sent
- **WHEN** the user opens the Last Sent view
- **THEN** an empty state SHALL be displayed with text explaining snapshots are in-memory only

## MODIFIED Requirements

### Requirement: CTX-01 — Inspector, Budget Bar, Source Toggle & Memory CRUD

The system SHALL provide a context inspector that displays context sources with token counts, a budget bar showing total usage, the ability to toggle sources on and off, context pills in chat input, and inline CRUD operations for topic and global memory entries.

The data backing the source list, token counts, and budget bar SHALL be derived from `assembleTopicContext()` via the canonical preview endpoint OR via the legacy `/api/context/analyze` endpoint (which itself SHALL delegate to `assembleTopicContext` for back-compat). All previously-defined CTX-01 scenarios continue to apply unchanged from the user's perspective.

The legacy `GET /api/context/analyze` response shape (`{ sources, totalTokens, budgetLimit, budgetPercent, warnings }`) SHALL be preserved exactly so existing client code continues to function. Internally, the route handler SHALL call `assembleTopicContext()` and project the envelope to the legacy shape.

#### Scenario: Legacy analyze endpoint shape unchanged
- **GIVEN** a topic with system prompt and 2 context files
- **WHEN** the client calls `GET /api/context/analyze?topicId=...`
- **THEN** the response SHALL have keys `sources`, `totalTokens`, `budgetLimit`, `budgetPercent`, `warnings`
- **AND** `sources[]` entries SHALL have keys `id`, `label`, `category`, `tokens`, `enabled`, `editable`, optional `preview`, `countInBudget`
- **AND** the schema SHALL be byte-compatible with the pre-refactor shape

#### Scenario: Legacy endpoint and preview endpoint agree on shared fields
- **GIVEN** a topic with arbitrary configuration
- **WHEN** the client calls both `GET /api/context/analyze?topicId=X` and `GET /api/topics/X/context-preview` (with default provider)
- **THEN** for each shared source: `id`, `category`, `tokens`, `enabled`, `editable`, `countInBudget` SHALL be identical between the two responses
- **AND** `totalTokens`, `budgetLimit`, `budgetPercent` SHALL be identical
- **AND** `warnings[]` SHALL contain the same items
