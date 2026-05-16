## ADDED Requirements

### Requirement: Composer exposes Fast mode toggle

The chat composer (`ChatInput`) SHALL expose a binary toggle button labeled "Fast mode" positioned in the left tool cluster of the action bar, between the Plan mode toggle and the Context budget ring.

The toggle SHALL:
1. Use the `Zap` icon (lucide-react) as its visual.
2. Be styled with `text-amber-500 bg-amber-500/10` when ON, and the standard muted style when OFF.
3. Expose `data-testid="chat-input-fast-mode"` for E2E selectors.
4. Show a tooltip explaining the current state and the model that will be used.
5. NOT be mutually exclusive with Plan mode — both toggles can be ON simultaneously.

#### Scenario: Toggle position in action bar
- **GIVEN** a chat topic is open and the composer is rendered
- **WHEN** the user inspects the left tool cluster of the action bar
- **THEN** the order SHALL be: Attach → Plan mode → Fast mode → Context ring → Provider/Model picker

#### Scenario: Toggle visual reflects state
- **GIVEN** the Fast mode toggle is rendered
- **WHEN** the user clicks the toggle
- **THEN** the icon container background SHALL switch between transparent (OFF) and `bg-amber-500/10` with `text-amber-500` (ON)
- **AND** the tooltip SHALL update to describe the new state

#### Scenario: Fast mode is independent from Plan mode
- **GIVEN** Plan mode is ON
- **WHEN** the user clicks the Fast mode toggle
- **THEN** Plan mode SHALL remain ON
- **AND** Fast mode SHALL also be ON
- **AND** the next `/api/chat` request SHALL carry both `planMode: true` AND `fastMode: true`

### Requirement: Chat request carries fastMode flag

The `/api/chat` route SHALL accept an optional `fastMode: boolean` field in the request body. When `fastMode === true` AND no per-message model override is supplied AND the topic has no persisted model, the route handler SHALL resolve the effective model via `getFastModelFor(provider.name)` and pass it as `options.model` to `provider.sendChat`.

#### Scenario: Fast mode resolves to provider-native fast model
- **GIVEN** a topic bound to provider `claude-code`
- **AND** the topic has no persisted `model`
- **WHEN** the client posts to `/api/chat` with `{ fastMode: true }` and no `model` field
- **THEN** the route handler SHALL call `getFastModelFor("claude-code")` which returns `"claude-haiku-4-5"`
- **AND** SHALL pass `options.model = "claude-haiku-4-5"` to `provider.sendChat`

#### Scenario: Picker override wins over Fast mode
- **GIVEN** the client posts to `/api/chat` with `{ fastMode: true, model: "claude-sonnet-4-6" }`
- **WHEN** the route handler resolves the effective model
- **THEN** the resolved model SHALL be `"claude-sonnet-4-6"` (picker wins)
- **AND** the route SHALL log an info message indicating Fast mode was bypassed

#### Scenario: Topic-persisted model wins over Fast mode
- **GIVEN** a topic with persisted `model: "claude-opus-4-1"` and no per-message `model` override
- **WHEN** the client posts `{ fastMode: true }`
- **THEN** the resolved model SHALL be `"claude-opus-4-1"` (topic persistence wins; fast mode is a transient override only when nothing else is set)

> NOTE: this priority differs from a naive "fastMode wins" — rationale is in `design.md`. The intent is to make fast mode the "soft default" without overriding explicit choices.

#### Scenario: Fast model unavailable falls back gracefully
- **GIVEN** the provider snapshot lists models that do NOT include `getFastModelFor(provider.name)`'s return value (e.g. an outdated CLI)
- **WHEN** the route handler resolves the effective model
- **THEN** the existing guard at the provider-snapshot validation step SHALL drop the override
- **AND** the route SHALL log a warning `[Chat] Fast mode requested but fast model unavailable for provider X — falling back to default`
- **AND** the request SHALL succeed using the provider's default model (no error surfaced to user)

#### Scenario: openclaw provider delegates fast model to gateway
- **GIVEN** a topic bound to provider `openclaw`
- **WHEN** the client posts `{ fastMode: true }`
- **THEN** `getFastModelFor("openclaw")` SHALL return `null`
- **AND** the route SHALL NOT set any `options.model` override based on fast mode
- **AND** the gateway SHALL receive the request with its default routing logic (out of scope for this change)
- **AND** the route SHALL log an info message indicating fast mode was delegated

### Requirement: Context envelope diagnostics expose fastMode

The `ContextEnvelope.diagnostics` object SHALL include an optional `fastMode?: boolean` field. The `assembleTopicContext()` function SHALL accept an `opts.fastMode?: boolean` parameter and propagate its value into `diagnostics.fastMode`.

#### Scenario: Diagnostics reflect fast mode opt
- **GIVEN** `assembleTopicContext()` is called with `opts.fastMode: true`
- **WHEN** the resulting envelope is inspected
- **THEN** `envelope.diagnostics.fastMode` SHALL equal `true`

#### Scenario: Diagnostics default to false when opt omitted
- **GIVEN** `assembleTopicContext()` is called without `opts.fastMode`
- **WHEN** the resulting envelope is inspected
- **THEN** `envelope.diagnostics.fastMode` SHALL equal `false` (or be absent — both acceptable; tests assert truthy equality only when true)

#### Scenario: Fast mode does NOT alter systemBlocks or history
- **GIVEN** two identical `/api/chat` calls differing only in `fastMode: false` vs `fastMode: true`
- **WHEN** both envelopes are assembled
- **THEN** `systemBlocks` SHALL be identical between the two
- **AND** `history` SHALL be identical between the two
- **AND** only `diagnostics.fastMode` (and the eventual `options.model` passed downstream) SHALL differ
