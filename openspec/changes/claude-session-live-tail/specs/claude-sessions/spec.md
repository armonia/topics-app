# Delta: claude-sessions — live JSONL tail

## ADDED Requirements

### Requirement: CCS-07 — Live JSONL tail drives phase between hooks

The system SHALL continuously tail every live session's JSONL transcript (DB-backed topic sessions AND in-memory terminal sessions) and apply new events to the phase machine with causal ordering, so that turns started by non-hook events (Monitor task-notifications, background task completions, teammate messages, injected prompts) are tracked while they run.

#### Scenario: Monitor wake-up lights the working state
- **GIVEN** a claude-code terminal session parked at `phase = 'awaiting-user'`
- **WHEN** a `<task-notification>` user line (origin.kind `task-notification`) is appended to its transcript
- **THEN** within one tail interval the session transitions to `phase = 'running'` and `session:state` is broadcast
- **AND** when the turn later ends with a `Stop` hook, the `running → awaiting-user` transition broadcasts again (the notifier sees a real transition and banners)

#### Scenario: Terminal sessions are tailed via derived transcript path
- **GIVEN** a terminal claude-code session registered with a known `cwd` and `claudeSessionId`
- **AND** no `SessionStart` hook has ever fired for it
- **WHEN** its canonical transcript (`~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl`) grows
- **THEN** the tail applies the new events to the in-memory phase state

#### Scenario: Stale lines never override a fresher hook (causal gate)
- **GIVEN** a session whose `Stop` hook set `phase = 'awaiting-user'` at time T2
- **WHEN** the tail reads an `assistant` line whose timestamp T1 < T2
- **THEN** the line is skipped and the phase remains `awaiting-user`

#### Scenario: Meta and local-command lines never fake a turn
- **GIVEN** a session parked at `awaiting-user`
- **WHEN** the transcript gains a user line that is `isMeta`, an `isCompactSummary`, a `<command-name>`/`<local-command…` echo, or a `[Request interrupted…]` marker
- **THEN** the phase is unchanged

#### Scenario: Registration against an existing transcript skips history
- **GIVEN** a terminal session registered while its transcript already holds N bytes of history
- **WHEN** the first tail sweep runs
- **THEN** only bytes appended after registration are ever read (offset snapped to N)

## MODIFIED Requirements

### Requirement: CCS-03 — Phase derivation from hooks

The system SHALL translate Claude Code hook events into `ClaudeSession` phase transitions according to the canonical table in `design.md`, and SHALL treat JSONL transcript events as a live co-driver of the same phase machine: a qualifying user-role line (typed prompt, task-notification, injected turn) or an assistant line moves any non-terminal phase to `running`, subject to the causal timestamp gate; `tool_use`/`tool_result` lines mirror `PreToolUse`/`PostToolUse`. Terminal phases (`completed`, `error`) are never revived by JSONL events.

#### Scenario: Assistant line revives a resting phase
- **GIVEN** a session at `phase = 'awaiting-user'` (its wake-up user line was gated or missed)
- **WHEN** the tail reads an `assistant` line with timestamp newer than `phaseUpdatedAt`
- **THEN** `phase = 'running'` and `rev` bumps
