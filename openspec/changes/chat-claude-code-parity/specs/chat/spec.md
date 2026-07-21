# Delta: chat — Claude Code CLI parity in the topic chat

## ADDED Requirements

### Requirement: CHAT-SOLID-01 — A turn's streamed output is never lost on finalization

The system SHALL persist message-row fields with field-isolated writes so that a tool/block/result update never overwrites the message's streamed `content`/`thinking` from a stale snapshot. A turn that produced visible streamed output SHALL NOT be finalized to empty content. When a turn ends abnormally (timeout, error, abort, or process kill), the system SHALL preserve whatever was already streamed (text and/or tool blocks) and attach a clear "interrupted/timed-out" marker atomically, never a bare empty bubble. The client SHALL render the tool-block timeline when final prose content is empty, rather than showing a vanished or empty message. There SHALL be a single authoritative turn-duration timeout, and it SHALL reset on genuine tool progress so that a long but actively-working agentic turn is not killed on a fixed wall-clock.

#### Scenario: Interleaved tool result does not erase streamed text
- **GIVEN** a heavy agentic turn streaming prose and tool calls concurrently
- **WHEN** a `tool_result` write and a content delta land near-simultaneously
- **THEN** the persisted row keeps both the accumulated text and the tool result (no full-row read-modify-write clobber)

#### Scenario: A timed-out turn keeps what it streamed
- **GIVEN** a turn that streamed text and tool calls and is then terminated by the turn-duration timeout
- **WHEN** the turn is finalized and the process is killed
- **THEN** the persisted assistant message retains the streamed text and/or the tool-block timeline
- **AND** it carries an explicit "[interrotto/timeout]" marker
- **AND** it is NOT persisted with empty content

#### Scenario: Late events after finalization cannot zero the row
- **GIVEN** an assistant message already finalized with content
- **WHEN** a burst of late `tool_result` events flushes as the killed process drains
- **THEN** none of them overwrites the finalized `content` with an empty value

#### Scenario: Empty-prose turn still renders its work
- **GIVEN** a persisted assistant message whose final prose content is empty but whose tool-block timeline is non-empty
- **WHEN** the topic is loaded
- **THEN** the tool-block timeline renders (the message does not disappear or show as blank)

#### Scenario: A single duration cap that respects progress
- **GIVEN** a long agentic turn that is actively emitting tool events
- **WHEN** each tool event arrives
- **THEN** the turn-duration timeout is reset (a working turn is not killed at a fixed 30-minute wall-clock)
- **AND** only a genuinely silent, non-progressing turn is bounded by the cap

### Requirement: CHAT-COMPACT-01 — Compaction is surfaced, persisted, and rendered

The system SHALL detect Claude Code context compaction from the CLI's `system`/`compact_boundary` stream event (parsed before the generic `system`-event drop), broadcast it as a `stream:compaction` event, persist it as a first-class display-only marker in the topic thread, and render it in the chat as a distinct "context compacted" divider. During the silent compaction window the chat SHALL show an explicit compaction/optimization state rather than the generic streaming spinner. Compaction SHALL NOT truncate or remove any previously-shown message from the chat (the SQLite thread stays authoritative), and the marker SHALL be excluded from the history assembled back into the model's context.

#### Scenario: Compaction boundary renders a divider with token counts
- **GIVEN** a claude-code chat turn is streaming
- **WHEN** the CLI emits `{type:"system", subtype:"compact_boundary"}` with `compact_metadata.pre_tokens`
- **THEN** a "Contesto compattato" divider appears in the transcript showing pre→post token counts and the trigger (auto/manual)
- **AND** no prior message in the thread is removed or truncated

#### Scenario: Compaction marker survives reload
- **GIVEN** a compaction divider is present in a topic
- **WHEN** the user reloads the client and re-opens the topic
- **THEN** the divider reappears in the same position (rehydrated from the persisted thread)

#### Scenario: Malformed boundary degrades gracefully
- **GIVEN** a `compact_boundary` event missing `compact_metadata`
- **WHEN** the provider parses it
- **THEN** a generic "context compacted" marker is shown (no token counts) and no error is raised

#### Scenario: Silent compaction shows an explicit state, not a bare spinner
- **GIVEN** a turn whose CLI child is alive but has emitted nothing past the soft-timeout (auto-compaction in progress)
- **WHEN** the grace window is first extended because `isTurnProcessAlive` is true
- **THEN** the chat shows an explicit "ottimizzazione del contesto…" state
- **AND** Stop remains available
- **AND** the state clears when the boundary arrives or the turn resumes emitting

#### Scenario: Marker never re-enters model context
- **GIVEN** a topic containing a persisted compaction marker
- **WHEN** provider history is assembled for the next turn
- **THEN** the compaction marker row is omitted from that history

#### Scenario: Giant compaction rewrite does not spike memory
- **GIVEN** a session transcript that grows by several megabytes in one compaction rewrite
- **WHEN** the live tail reads the new bytes
- **THEN** the read is bounded to at most the configured cap per sweep (no single multi-MB allocation)

### Requirement: CHAT-SLASH-01 — Slash-command parity for claude-code chats

The system SHALL handle the core Claude Code slash commands on claude-code topic chats. `/model` and `/reasoning`/`/effort` SHALL apply to claude-code (not only openclaw) by driving the existing per-topic respawn path. `/clear` SHALL reset the CLI session (new session id), not merely wipe the local message table. `/context`, `/cost`, and `/status` SHALL report from data the app already tracks. A single source-of-truth command table SHALL drive the composer allowlist, the `/help` text, and the submit dispatcher. Any input not matching a handled command SHALL be sent to the model verbatim.

#### Scenario: /model switches the model on a claude-code topic
- **GIVEN** a claude-code topic
- **WHEN** the user sends `/model claude-opus-4-8`
- **THEN** the command is accepted (no HTTP 400)
- **AND** the next turn runs on the selected model

#### Scenario: /clear resets the CLI session
- **GIVEN** a claude-code topic with prior turns
- **WHEN** the user runs `/clear` and confirms
- **THEN** the local thread is backed up and cleared
- **AND** the next spawn uses a fresh session id (not `--resume` of the old session)

#### Scenario: /context and /cost report real data
- **GIVEN** a claude-code topic mid-conversation
- **WHEN** the user runs `/context` or `/cost`
- **THEN** a reply reports the current token budget/usage (context) or session token/cost totals

#### Scenario: A path-like message is not swallowed
- **GIVEN** the composer
- **WHEN** the user sends `/Users/me/file.txt is broken`
- **THEN** it is not treated as a command and reaches the model unchanged

#### Scenario: /help matches the real allowlist
- **WHEN** the user runs `/help`
- **THEN** the listed commands are exactly those the dispatcher actually handles

### Requirement: CHAT-PERM-01 — Opt-in per-topic permission prompts

The system SHALL default to no permission prompts in chat (bypass), preserving today's frictionless behaviour. When a per-topic permission-prompt flag is enabled, the system SHALL spawn the CLI in a prompting permission mode, surface each `can_use_tool` control request as a `stream:permission_required` event with an allow / deny / always card in the chat, write the decision back to the CLI as a control response, and remember an "always" decision for the session. An unanswered request SHALL be bounded by the existing hard timeout and SHALL resolve to deny (never auto-allow).

#### Scenario: Default topic never prompts
- **GIVEN** a topic with the permission-prompt flag off
- **WHEN** the assistant uses any tool
- **THEN** no permission card appears and the tool runs (unchanged from today)

#### Scenario: Opt-in topic prompts and honours allow
- **GIVEN** a topic with the permission-prompt flag on
- **WHEN** the CLI requests permission for a tool
- **THEN** an allow/deny/always card appears in the chat
- **AND** choosing allow lets the tool run

#### Scenario: Deny blocks the tool
- **GIVEN** a pending permission card on an opt-in topic
- **WHEN** the user chooses deny
- **THEN** the tool does not run and the turn continues with the denial

#### Scenario: Always allow stops re-prompting for that tool
- **GIVEN** the user chose "always allow" for a tool on an opt-in topic
- **WHEN** the assistant uses the same tool again in the session
- **THEN** no further permission card appears for it

#### Scenario: Permission card survives reload
- **GIVEN** a pending permission card
- **WHEN** the client reloads
- **THEN** the pending card is restored and can still be answered

### Requirement: CHAT-OOT-01 — Out-of-turn completions render inline (render-only)

The system SHALL surface events that arrive after a turn's `result` — Monitor notifications and background-task (`run_in_background`) completions — as display-only system entries in the message list, in addition to the existing completion toast. The system SHALL NOT auto-resume the model in response to such events. Monitor / background-Bash tool activity SHALL render as typed tool rows, not generic unknown rows.

#### Scenario: Monitor completion renders as a system entry
- **GIVEN** a completed turn on a claude-code topic that had started a Monitor
- **WHEN** the Monitor emits a completion event after the turn ended
- **THEN** a muted system entry describing it appears in the message list
- **AND** no new assistant turn is started automatically

#### Scenario: Background Bash completion is surfaced, not dropped
- **GIVEN** a background (`run_in_background`) Bash task started in a prior turn
- **WHEN** it completes after the turn's result
- **THEN** its completion appears as a system entry (previously dropped)

#### Scenario: Out-of-turn markers stay out of model context
- **GIVEN** a topic containing out-of-turn system entries
- **WHEN** provider history is assembled
- **THEN** those entries are omitted

#### Scenario: Monitor tool row is typed
- **GIVEN** the assistant invokes the Monitor tool
- **WHEN** the row renders
- **THEN** it shows a typed Monitor row (description/status), not a generic unknown row

### Requirement: CHAT-PROC-01 — Detached chat process survives client and server disruption

The system SHALL run each claude-code chat turn in a process detached from the HTTP server (the ai-bridge broker), such that a server reload, crash, or restart does not kill an in-flight turn; on server boot the system SHALL adopt still-running mid-turn sessions and reap idle ones; and a client disconnect SHALL NOT abort the turn. This behaviour SHALL be enabled by default in production, and the daemon's session state SHALL be observable in diagnostics.

#### Scenario: Turn survives a server reload
- **GIVEN** a claude-code chat turn is streaming
- **WHEN** the server process reloads/restarts
- **THEN** the turn continues in the broker and the client re-attaches to it, without losing the in-flight response

#### Scenario: Client disconnect does not abort the turn
- **GIVEN** a streaming turn
- **WHEN** the initiating client tab closes or its connection drops
- **THEN** the turn continues and its result is persisted and broadcast

#### Scenario: Broker is default-on in production
- **GIVEN** the production start path on macOS/Linux
- **WHEN** the server starts
- **THEN** the broker is active (not disabled by configuration) and a boot log/self-check confirms the broker socket is reachable

#### Scenario: Daemon state is observable
- **GIVEN** live and idle broker sessions
- **WHEN** an operator opens diagnostics
- **THEN** live/adopted/reaped sessions and store size are shown (read-only)

### Requirement: CHAT-TODO-01 — Sticky current-todo strip

The system SHALL render the latest `TodoWrite` for a claude-code chat as a compact, collapsible strip above the composer that updates in place, in addition to the inline transcript rows.

#### Scenario: Todo strip tracks the latest plan
- **GIVEN** a claude-code turn that issues successive `TodoWrite` updates
- **WHEN** each update arrives
- **THEN** the sticky strip above the composer updates in place to the latest todo state
- **AND** the inline transcript rows are unaffected

## MODIFIED Requirements

### Requirement: CHAT-01 — Message Lifecycle

The system SHALL support sending messages, receiving streamed responses, loading conversation history, and aborting in-progress streams. The message lifecycle SHALL additionally admit **display-only system rows** — compaction markers (CHAT-COMPACT-01) and out-of-turn completion entries (CHAT-OOT-01) — which render in the transcript, persist and rehydrate with history, and are excluded from the context assembled back into the model.

#### Scenario: Send message and receive streamed response
- **GIVEN** the message input is visible in an active topic
- **WHEN** the user types a message and presses Enter
- **THEN** the user message appears in the message list
- **AND** an assistant response streams in progressively

#### Scenario: System rows render and persist alongside chat messages
- **GIVEN** a topic whose thread contains a compaction marker and an out-of-turn completion entry
- **WHEN** the topic is loaded
- **THEN** both render as distinct system entries in the correct chronological position
- **AND** they survive a reload
- **AND** neither is sent back into the model's context

#### Scenario: Abort streaming via stop button
- **GIVEN** a message is being streamed with a streaming indicator visible
- **WHEN** the user clicks the stop button
- **THEN** streaming stops immediately
- **AND** the partial response text remains visible
- **AND** the message input becomes re-enabled

### Requirement: CHAT-TOOL-01 — Lo stato "running" copre l'utilizzo reale del tool

Il sistema SHALL mostrare una tool call come attiva (`running`) per tutta la finestra di utilizzo reale: dalla partenza della generazione dell'input da parte del modello fino all'arrivo del risultato — non solo durante l'esecuzione. Il `ToolCall` SHALL registrare `startedAt`/`endedAt` e la UI SHALL mostrare la durata reale. La stessa riga di tool SHALL rappresentare anche gli stati di attesa umana — `waiting_for_input` (AskUserQuestion/elicitation) e `waiting_for_permission` (CHAT-PERM-01) — senza mostrare uno spinner fuorviante, e i tool a lunga vita o in background (Monitor, background Bash) SHALL avere un rendering tipizzato.

#### Scenario: tool con input lungo appare subito
- **GIVEN** un turno claude-code in cui il modello genera un Edit con input corposo
- **WHEN** il modello inizia a scrivere l'input del tool
- **THEN** la riga del tool appare subito in stato running (nome noto, args in arrivo)
- **AND** resta running finché il risultato non arriva

#### Scenario: la riga distingue attesa di permesso da esecuzione
- **GIVEN** un topic con prompt di permesso attivi in cui un tool richiede un permesso
- **WHEN** la richiesta è pendente
- **THEN** la riga mostra lo stato `waiting_for_permission` con la card allow/deny/always
- **AND** non mostra lo spinner di esecuzione

#### Scenario: durata reale visibile
- **GIVEN** una tool call completata
- **WHEN** l'utente guarda la riga
- **THEN** vede la durata effettiva (endedAt − startedAt) accanto allo stato
