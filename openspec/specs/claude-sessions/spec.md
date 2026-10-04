# Claude Sessions

## Purpose

Canonical tracking of Claude Code CLI session state (phase machine fed by hooks, with reaper and boot-time JSONL recovery).

## Requirements

### Requirement: CCS-01 — Canonical Claude Code session state

The system SHALL maintain a single canonical `ClaudeSession` record per Claude Code CLI session, with a deterministic `phase` enum and a monotonic revision counter. A session bound to a Topics `session_key` is persisted in `claude_code_sessions` and survives server restarts; one without a `session_key` is held in the tracker's in-memory store for the life of the process and re-registered when its pane reattaches.

> The record is created by whoever SPAWNS the session, never by observing it. The tracker reads hooks and transcripts for sessions it already knows — it does not adopt strangers (see the `unknown-session` scenario below and `server/lib/claude-session-tracker.ts`).

#### Scenario: The spawner creates the record, and the same call decides the argv
- **GIVEN** no `claude_code_sessions` row exists for `session_key = K`
- **WHEN** Topics spawns a chat turn for that topic (`getOrCreateClaudeSessionId`, `server/providers/claude-code.ts`)
- **THEN** one row is inserted binding `session_key = K` to a freshly minted `claude_session_id`, with the schema default `phase = 'dormant'`, `rev = 0`, `jsonl_offset = 0`
- **AND** the call reports `isNew = true`, which is what puts `--session-id <id>` in the argv; every later call on the same `session_key` returns the SAME id with `isNew = false`, i.e. `--resume <id>`
- **AND** `isNew` is decided by which side of the upsert won (the id that comes back), never by comparing timestamps — two spawns in the same millisecond must not both look new

#### Scenario: A hook for a session Topics never started creates nothing
- **GIVEN** neither a `claude_code_sessions` row nor an in-memory terminal state exists for `claude_session_id = X`
- **WHEN** an authenticated, non-duplicate hook for X arrives
- **THEN** the tracker returns `{kind: 'unknown-session'}` — answered 200 per CCS-02 — and inserts NO row
- **AND** no state is created or mutated: an unknown session stays unknown until something in Topics spawns or registers it

#### Scenario: A terminal pane without a topic is tracked in memory, not in the table
- **GIVEN** a Claude Code terminal pane spawned with no Topics `session_key`
- **WHEN** `registerTerminalSession(claude_session_id, {cwd})` runs at spawn or at reattach
- **THEN** the session enters the tracker's in-memory store with `phase = 'starting'`, `rev = 0` and its canonical transcript path, so its hooks and its JSONL tail resolve
- **AND** no `claude_code_sessions` row is written — that table is keyed by `session_key`, which this session does not have
- **AND** the call is a no-op when a DB row already owns that id (topic-bound panes keep the persisted record as the single source of truth)

#### Scenario: Phase transitions bump rev monotonically
- **GIVEN** a `ClaudeSession` with `rev = N` and `phase = 'running'`
- **WHEN** the tracker observes a `Stop` hook for that session
- **THEN** the row is updated to `phase = 'awaiting-user'`, `rev = N + 1`, `phase_updated_at = now`
- **AND** no out-of-order update with `rev <= N` is accepted

#### Scenario: Recovery replays JSONL from persisted offset on boot
- **GIVEN** the server was killed mid-stream and `claude_code_sessions.jsonl_offset = K` for session X
- **AND** the JSONL file now has size `K + delta` bytes
- **WHEN** the server boots and the tracker initialises
- **THEN** the tracker reads bytes `[K, K+delta)`, applies each complete event, and persists the resulting phase + new offset
- **AND** any partial last line (no trailing newline) is left for the next read

### Requirement: CCS-02 — Hook endpoint security and idempotency

The system SHALL expose `POST /api/claude-hooks/:event` that accepts Claude Code hook payloads, authenticates them with a per-install bearer token, enforces localhost-only access, and deduplicates rapid duplicates.

The token SHALL be written under Topics' OWN home (`${TOPICS_HOME:-~/.topics}/claude-hooks/hook-token`, mode 0600) and NEVER under the user's Claude configuration directory. A token left by an older version at `~/.claude/topics-hook-token` or `~/.claude/topics-app/hook-token` SHALL still be READ, so that a wrapper already installed keeps authenticating, and SHALL NOT be rewritten.

#### Scenario: Unauthenticated request rejected
- **GIVEN** the hook endpoint is registered
- **WHEN** a POST arrives without `Authorization: Bearer <token>` matching the token file
- **THEN** the server responds 401 and the session state is unchanged

#### Scenario: The token is created in Topics' own home
- **GIVEN** an installation with no token anywhere
- **WHEN** the server resolves the hook token
- **THEN** it SHALL be written under `${TOPICS_HOME:-~/.topics}/claude-hooks/`
- **AND** nothing SHALL be created under `~/.claude`

#### Scenario: A legacy token is adopted, not rewritten
- **GIVEN** a token file left by an older version under `~/.claude`
- **WHEN** the server resolves the hook token
- **THEN** that value SHALL be adopted and persisted in Topics' own home
- **AND** the legacy directory SHALL be left exactly as it was

#### Scenario: Non-localhost request rejected
- **GIVEN** the hook endpoint is registered
- **WHEN** a POST arrives from a remote address other than `127.0.0.1` or `::1`
- **THEN** the server responds 403 and the session state is unchanged

#### Scenario: Duplicate events deduplicated within 100ms window
- **GIVEN** a hook for `(claude_session_id=X, event=Stop, timestamp=T)` was processed
- **WHEN** an identical payload arrives within 100ms
- **THEN** the second is acknowledged with 200 but does not alter the state, does not bump `rev`, does not broadcast

#### Scenario: Rate limit applied per claude_session_id
- **GIVEN** session X has produced 50 hook events in the past second
- **WHEN** a 51st event arrives within the same window
- **THEN** the server responds 200 with `{ok: true, result: 'rate-limited'}` and the event is dropped without altering session state
- **AND** a warning is logged with `claude_session_id` and event name

> Note: the endpoint deliberately never returns 4xx to authenticated hook callers — hook wrapper scripts must never crash a Claude Code session because the server refused an event. 4xx is reserved for protocol-level failures (bad token, non-localhost, malformed JSON); semantic outcomes (dedup, rate-limit, unknown session) are reported in the 200 body's `result` kind (see `server/routes/claude-hooks.ts`).

### Requirement: CCS-03 — Phase derivation from hooks

The system SHALL translate Claude Code hook events into `ClaudeSession` phase transitions according to the canonical table in `design.md`.

#### Scenario: UserPromptSubmit advances to running and clears pending approval
- **GIVEN** a session with `phase = 'awaiting-approval'` and a `pendingApproval` payload
- **WHEN** a `UserPromptSubmit` hook is received
- **THEN** `phase = 'running'`, `pendingApproval = null`, `rev` is bumped

#### Scenario: PreToolUse captures tool metadata
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a `PreToolUse` hook is received with `tool_name='Bash'`, `tool_input={command:'ls'}`
- **THEN** `phase = 'tool-running'`, `lastTool = {name:'Bash', input:{command:'ls'}, startedAt:now}`

#### Scenario: PostToolUse returns to running
- **GIVEN** a session with `phase = 'tool-running'`
- **WHEN** a `PostToolUse` hook for the same tool is received
- **THEN** `phase = 'running'`, `lastTool = null`

#### Scenario: Notification with permission_request enters awaiting-approval
- **GIVEN** a session in any active phase
- **WHEN** a `Notification` hook is received whose payload includes a permission request (`title` matches `/permission|approval/i` or `payload.permission_request` is set)
- **THEN** `phase = 'awaiting-approval'`, `pendingApproval` is populated with `{kind, prompt, requestedAt}`

#### Scenario: SessionEnd marks completed
- **GIVEN** any active session
- **WHEN** a `SessionEnd` hook is received
- **THEN** `phase = 'completed'`, `lastTool = null`, `pendingApproval = null`

#### Scenario: Hooks are applied in the order they fired, not the order they arrived
- **GIVEN** the hooks are async and each carries the time it fired (`X-Topics-Hook-Fired-At`, set by the hook script)
- **WHEN** a hook arrives that fired before a hook already applied to the same session (a `PreToolUse` after the `Stop` of its turn, a `SessionStart` after the first prompt)
- **THEN** its phase change is not applied and the result is `{kind: 'stale'}`
- **AND** a late `SessionStart` still sets the transcript path, and a late task (a `Monitor`) still turns a finished turn into `watching`
- **AND** a `PreToolUse` whose `PostToolUse` (same `tool_use_id`) already arrived changes nothing

### Requirement: CCS-04 — Stale-phase reaper

The system SHALL run a periodic sweep that demotes sessions stuck in transient phases beyond fixed timeouts, ensuring the state never gets pinned by a missed hook.

#### Scenario: tool-running stuck demoted to running
- **GIVEN** a session with `phase = 'tool-running'` and `phase_updated_at` is 11 minutes in the past
- **WHEN** the reaper runs
- **THEN** the session transitions to `phase = 'running'`, `lastTool = null`, `rev` bumped

#### Scenario: awaiting-approval timeout demoted to paused
- **GIVEN** a session with `phase = 'awaiting-approval'` and `phase_updated_at` is 11 minutes in the past
- **WHEN** the reaper runs
- **THEN** the session transitions to `phase = 'paused'`, `rev` bumped, `pendingApproval` retained for UI display

#### Scenario: PTY crash without SessionEnd marked error
- **GIVEN** a session whose PTY exited with code ≠ 0 and no `SessionEnd` hook arrived within 5 seconds
- **WHEN** the reaper runs
- **THEN** the session transitions to `phase = 'error'` with `error = {code:'pty-crashed', message:'PTY exited with code N', failedAt:now}`

#### Scenario: running with silent PTY demoted to dormant (DB-backed and in-memory alike)
- **GIVEN** a session with `phase = 'running'` whose PTY has been idle beyond `runningTimeoutMs` (a missed `Stop` hook, not a long turn — a live turn keeps the PTY busy)
- **WHEN** the reaper runs
- **THEN** the session transitions to `phase = 'dormant'` (revivable: the next PTY frame or transcript line brings it back to `running`)
- **AND** the rule applies to DB-backed topic sessions exactly as to in-memory terminal sessions — both sweeps receive the PTY-idle signal

#### Scenario: abandoned running session without any PTY signal demoted to dormant
- **GIVEN** a session with `phase = 'running'` and no PTY signal at all (a headless dispatcher task via `claude --print`, a chat session, or a PTY that vanished with the bridge) whose `updatedAt` — advanced by every hook and every consumed transcript line — has been frozen beyond `abandonedTimeoutMs` (default 60 min)
- **WHEN** the reaper runs
- **THEN** the session transitions to `phase = 'dormant'`, never a terminal phase — the live tail still covers dormant sessions, so a merely-quiet session is revived by its next transcript line

### Requirement: CCS-05 — WS broadcast contract

The system SHALL broadcast `{type:'session:state', sessionKey, state}` on every phase transition, with coalescing of rapid bursts.

#### Scenario: Single transition broadcast immediately
- **GIVEN** a connected WebSocket client subscribed to session state
- **WHEN** the tracker performs one transition
- **THEN** the client receives one `session:state` message within 100ms

#### Scenario: Burst of transitions coalesced to the latest
- **GIVEN** a connected WebSocket client subscribed to session state
- **WHEN** the tracker performs three transitions within 30ms for the same session
- **THEN** the client receives a single `session:state` message reflecting the final state
- **AND** the message carries the highest `rev` of the three transitions

### Requirement: CCS-06 — Hook installer idempotency

The system SHALL provide a script that installs Topics App hook wrappers into `~/.claude/settings.json` without overwriting unrelated user hooks, and a symmetric uninstaller.

#### Scenario: First-time install
- **GIVEN** the user has never run the installer
- **WHEN** the user runs `bun run hooks:install`
- **THEN** `~/.claude/topics-hooks/` exists with ONE shared wrapper script (`post-hook.sh`), registered for 7 hook events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` — `SubagentStop` intentionally dropped, a no-op in `applyHook`)
- **AND** `~/.claude/settings.json` contains a `hooks` block referencing that wrapper with the event name as argument
- **AND** the hook token exists with mode 0600 under `${TOPICS_HOME:-~/.topics}/claude-hooks/`

#### Scenario: Re-running installer is idempotent
- **GIVEN** the installer was already run successfully
- **WHEN** the user runs `bun run hooks:install` again
- **THEN** `~/.claude/settings.json` is unchanged byte-for-byte
- **AND** the existing token is reused

#### Scenario: Installer preserves unrelated user hooks
- **GIVEN** `~/.claude/settings.json` already contains a user `Stop` hook for an unrelated script
- **WHEN** the installer runs
- **THEN** the user's `Stop` hook entry is preserved
- **AND** the Topics App `Stop` hook entry is added as an additional matcher

#### Scenario: Fire-and-forget events do not hold the turn
- **WHEN** the installer runs, or a Topics spawn passes the hooks through `--settings`
- **THEN** the `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification` and `Stop` entries carry `async: true`
- **AND** only `SessionEnd` stays blocking (an async hook running when the CLI exits is cut), every entry with `timeout: 5`
- **AND** no entry is written for an event Claude Code does not emit (`MonitorArmed`, `MonitorClosed`)

#### Scenario: Installer repairs entries written before the marker
- **GIVEN** `~/.claude/settings.json` holds wrapper entries without `topics_app`, with the path quoted or not, in any matcher of the event
- **WHEN** the installer runs
- **THEN** each one is rewritten in place to the current shape, and every event ends with exactly one Topics App entry
- **AND** running the installer again leaves the file unchanged byte-for-byte
- **AND** the uninstaller recognises and removes those entries too

#### Scenario: Uninstaller removes only Topics App entries
- **GIVEN** the installer has run and the user added their own hook afterward
- **WHEN** the user runs `bun run hooks:uninstall`
- **THEN** the Topics App hook entries are removed from `~/.claude/settings.json`
- **AND** the user's own hooks remain intact
- **AND** `~/.claude/topics-hooks/` is deleted

### Requirement: MONITOR-04 — While a Monitor is armed the chat reads as watching, not as finished

A session that ends its turn with background work still in flight is not waiting for the
user: the answer will arrive by itself. The system SHALL track that work per task id,
for every tool that leaves it behind (`Monitor`, `Bash` or `Agent` with
`run_in_background`, `Workflow`, a non-recurring `CronCreate`), and SHALL park the
session in `watching` at `Stop` whenever at least one task is in flight, and in
`awaiting-user` when none is. A task SHALL leave the set when its own completion arrives
(the transcript's `<task-notification>` for that id, the Monitor's delivery or end
including expiry, the cron's first fire or `CronDelete`), not on any wake of the session.
`SessionEnd` and process exit SHALL empty the set. The set SHALL survive a server reload
while the process holding it is alive.

The set SHALL have one holder, the attention store (`subject_attention.background`): the
phase machine SHALL read from it how many tasks count at `Stop` rather than keep a set of
its own. A recurring `CronCreate` SHALL sit in the set marked recurring, so the chat can
show it, but SHALL NOT count toward `watching`.

#### Scenario: Starting a Monitor arms the watch without changing the phase
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a `PreToolUse` hook arrives with `tool_name = 'Monitor'`
- **THEN** `phase = 'tool-running'` as for any other tool
- **AND** the Monitor's task is in the in-flight set

#### Scenario: The end of the turn parks the chat in watching
- **GIVEN** a session that armed a Monitor during the turn
- **WHEN** the tool's `PostToolUse` and then the turn's `Stop` arrive
- **THEN** `phase = 'watching'` rather than `awaiting-user`

#### Scenario: Background Bash, Agent and Workflow park it in watching too
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a `Bash` or an `Agent` with `run_in_background: true`, or a `Workflow`, runs and then `Stop` arrives
- **THEN** `phase = 'watching'`
- **AND** a foreground `Bash` SHALL NOT enter the set, and its `Stop` SHALL give `awaiting-user`

#### Scenario: A recurring cron does not park it in watching
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a recurring `CronCreate` runs and then `Stop` arrives
- **THEN** `phase = 'awaiting-user'`, with the cron in the set marked recurring

#### Scenario: One of two tasks returns
- **GIVEN** a session in `watching` with two tasks in flight
- **WHEN** the completion of one arrives and the woken turn ends
- **THEN** `phase = 'watching'`, with one task left

#### Scenario: The last task returns
- **GIVEN** a session in `watching` with one task in flight
- **WHEN** its completion arrives and the woken turn ends
- **THEN** `phase = 'awaiting-user'`

#### Scenario: An expired Monitor on a terminal
- **GIVEN** a terminal session in `watching` for one Monitor
- **WHEN** the transcript reports the Monitor expired and the next `Stop` arrives
- **THEN** `phase = 'awaiting-user'`, not `watching`

#### Scenario: A new session does not inherit an old watch
- **GIVEN** a session in `watching`
- **WHEN** a `SessionStart` hook arrives
- **THEN** `phase = 'starting'` and the in-flight set SHALL be empty

#### Scenario: The legacy Monitor hooks keep working
- **GIVEN** a CLI old enough to emit `MonitorArmed` and `MonitorClosed`
- **WHEN** `MonitorArmed` arrives
- **THEN** the phase SHALL move to `watching` with the Monitor in the set
- **AND** `MonitorArmed` SHALL NOT override `awaiting-approval`
- **AND** `MonitorClosed` SHALL remove the Monitor, and from `watching` with an empty set SHALL return to `awaiting-user`

#### Scenario: Watching counts as an active phase, not a resting one
- **GIVEN** the client's phase classification
- **WHEN** `watching` is classified
- **THEN** it SHALL be one of the active phases, beside `running` and `tool-running`

### Requirement: TITLE-01 — Il titolo di una sessione esterna si deriva, e la marcatura dell'ospite non lo diventa MAI

Il titolo SHALL preferire l'ULTIMO titolo generato — l'argomento della sessione
si evolve — poi l'ultimo messaggio inviato, poi il PRIMO messaggio della persona.

I contenuti a blocchi SHALL essere gestiti; gli spazi SHALL essere collassati e
il titolo TAGLIATO alla lunghezza dichiarata.

Trascrizioni vuote o inutilizzabili SHALL dare NIENTE. Le righe malformate SHALL
essere ignorate senza impedire di trovare un titolo valido.

**La marcatura dell'ospite NON SHALL MAI diventare un titolo**, e un comando non
SHALL essere preso come ultimo messaggio: SHALL essere tenuto quello precedente.
Una trascrizione di sola marcatura SHALL dare NIENTE, non la marcatura. Il PRIMO
messaggio VERO SHALL vincere su uno di sola marcatura che lo precede.

La derivazione INCREMENTALE SHALL aggiornare il titolo quando un titolo nuovo si
aggiunge; una riga finale NON TERMINATA SHALL essere usata in modo
opportunistico e NON consumata; un carattere multi-byte spezzato al confine del
frammento SHALL sopravvivere; un file RIMPICCIOLITO — ruotato — SHALL essere
riletto da zero; e un file assente SHALL dare NIENTE.

#### Scenario: una trascrizione di sola marcatura
- **GIVEN** nessun messaggio vero
- **THEN** SHALL dare niente

#### Scenario: un carattere multi-byte al confine del frammento
- **GIVEN** una lettura incrementale che spezza il carattere
- **THEN** SHALL sopravvivere

### Requirement: SESSENV-01 — What a session inherited is visible from the app

Topics does not reimplement hooks, skills, custom commands, MCP servers or
permission rules: it spawns the CLI with `--setting-sources user,project,local`,
so what a person wrote under their home folder and under the project is already
in force. The consequence, until this requirement, was a chat that inherited an
entire environment and showed none of it.

The system SHALL report, for one topic and without writing anything: the MCP
servers the session gets and the reason each absent one is absent; the hooks in
force per event; the commands and skills discovered on disk; and the permission
rules with the mode in force. Every entry SHALL carry the FILE it came from,
because which of the settings files wins is the question that made someone look.

A runtime that does NOT read those setting sources SHALL be reported as such,
instead of being shown a list that is true for a different engine.

Secrets SHALL NOT reach the payload: an MCP definition carries tokens in its
`env` block, in its argv and in its url, and this answer is rendered in a
browser.

#### Scenario: every entry says which file declared it
- **GIVEN** hooks declared in the user, project and local settings files
- **WHEN** the session environment is read
- **THEN** each hook SHALL carry its event, its matcher and the file it came from

#### Scenario: an absent server explains itself
- **GIVEN** a configured MCP server that this session does not get
- **THEN** the answer SHALL carry the rule or the scoping that dropped it

#### Scenario: a hook installed by Topics is declared as such
- **GIVEN** a session that runs with the guard Topics installs itself
- **THEN** that hook SHALL appear marked as the app's, not as the user's

#### Scenario: no token leaves the server
- **GIVEN** a server configured with a token in argv, in a url query and in `env`
- **THEN** none of those values SHALL appear in the answer
