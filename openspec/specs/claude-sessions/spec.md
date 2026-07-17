# Claude Sessions

Canonical tracking of Claude Code CLI session state (phase machine fed by hooks, with reaper and boot-time JSONL recovery).

### Requirement: CCS-01 — Canonical Claude Code session state

The system SHALL maintain a single canonical `ClaudeSession` record per Claude Code CLI session, with a deterministic `phase` enum and a monotonic revision counter, persisted across server restarts.

#### Scenario: New session inserted on first observation
- **GIVEN** no `claude_code_sessions` row exists for `claude_session_id = X`
- **WHEN** the server observes either a `SessionStart` hook or a JSONL file at the canonical path
- **THEN** a row is inserted with `phase = 'starting'`, `rev = 0`, `jsonl_offset = 0`
- **AND** the row is associated to a Topics `session_key` if the spawning pane had one

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

#### Scenario: Unauthenticated request rejected
- **GIVEN** the hook endpoint is registered
- **WHEN** a POST arrives without `Authorization: Bearer <token>` matching `~/.claude/topics-app/hook-token`
- **THEN** the server responds 401 and the session state is unchanged

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
- **AND** `~/.claude/topics-app/hook-token` exists with mode 0600

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

#### Scenario: Uninstaller removes only Topics App entries
- **GIVEN** the installer has run and the user added their own hook afterward
- **WHEN** the user runs `bun run hooks:uninstall`
- **THEN** the Topics App hook entries are removed from `~/.claude/settings.json`
- **AND** the user's own hooks remain intact
- **AND** `~/.claude/topics-hooks/` is deleted
