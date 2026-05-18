## Delta vs base `terminal/spec.md`

Adds the `claude-code-team` session type with Agent Teams flag. Existing terminal behaviour unchanged.

## Requirements

### Requirement: TERM-DELTA-01 — Claude-code-team session type

The system SHALL support a new session type `'claude-code-team'` which behaves like `'claude-code'` but injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the spawned process environment.

#### Scenario: Team-mode session starts with flag
- **GIVEN** the user creates a terminal session via API with `type: 'claude-code-team'`
- **WHEN** the PTY bridge spawns the process
- **THEN** the child process environment contains `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- **AND** the process command is `claude` without `--print`
- **AND** the session is resumable via `--resume <claude_session_id>`

#### Scenario: Team-mode session shares persistence rules with claude-code
- **GIVEN** a `claude-code-team` session exits cleanly
- **WHEN** the user reconnects via the API with the same idempotency key
- **THEN** the session is resumed using `--resume`
- **AND** the team flag is re-injected

### Requirement: TERM-DELTA-02 — Programmatic provider relabel

The system SHALL label the existing `--print`-based provider as "programmatic / advanced" in the UI, and default new topics to the interactive `claude-code` (or `claude-code-team` for masters) path.

#### Scenario: New topic defaults to interactive PTY
- **GIVEN** the user creates a new topic via the New Topic dialog
- **WHEN** the AI provider selector renders
- **THEN** the default option is "Claude Code (interactive)"
- **AND** the `--print` provider option is grouped under "Advanced / programmatic"
- **AND** a tooltip on the advanced option explains it uses the pool credit billing path
