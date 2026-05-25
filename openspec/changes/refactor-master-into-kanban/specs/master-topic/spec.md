## MODIFIED Requirements

### Requirement: MASTER-01 — Master Topic creation (subscription, global)

The system SHALL allow creating a single global Master Topic that runs on the `claude-code` chat provider (the `claude` CLI under the user's Pro/Max subscription), designated `agent_team_role='lead'`. It SHALL NOT default to the `claude-code-team` provider, and SHALL NOT require an `ANTHROPIC_API_KEY`.

#### Scenario: Master is created on the subscription provider
- **GIVEN** the `claude` CLI is installed and authenticated to a Pro/Max subscription
- **AND** no `ANTHROPIC_API_KEY` is set in the environment
- **WHEN** the user creates a global Master (POST `/api/topics/master` with no `projectPath`)
- **THEN** the created topic has `provider = "claude-code"`
- **AND** sending a message to the Master streams a reply produced by the `claude` CLI (no Anthropic SDK call)

#### Scenario: Unregistered team provider is never the default
- **GIVEN** the provider registry registers `claude-code` but not `claude-code-team`
- **WHEN** a Master Topic is created without an explicit `provider`
- **THEN** the topic's `provider` is `"claude-code"`
- **AND** `getProvider` is never called with `"claude-code-team"` for the Master flow

#### Scenario: Clear error when the CLI provider is unavailable
- **GIVEN** the `claude-code` provider failed to initialize (CLI missing)
- **WHEN** the user creates a Master Topic
- **THEN** the endpoint returns a 500 with a remediation message naming the missing `claude` CLI
- **AND** does not create a half-initialized Master topic

#### Scenario: One global Master, not one per section
- **GIVEN** an active global Master already exists
- **WHEN** the user requests another global Master
- **THEN** the existing Master is focused/resumed instead of creating a duplicate
- **AND** no additional `claude` process is spawned for a second global brain

## REMOVED Requirements

### Requirement: MASTER-02 — Teammate spawn and binding (PTY Agent Teams)

**Reason**: The experimental Claude Code Agent Teams PTY path (`claude-code-team` sessionType + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) is removed from the Master flow. The Master no longer spawns teammate Topics or sub-agents; it is a single chat-delega brain reading the app's own DB. Orchestration of real multi-agent execution is out of scope and, where needed, is served by Anthropic's native tooling outside this app.

**Migration**: Existing Master topics keep working once their `provider` is read as `claude-code` (MASTER-01). No teammate topics are auto-created; any previously spawned teammate topics remain as ordinary topics.

### Requirement: MASTER-03 — Agent Teams experimental flag

**Reason**: The Master flow SHALL NOT set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. The flag tied the Master to an experimental, unstable Anthropic feature. The `claude-code-team` terminal type MAY still be created manually by a user, but is never the Master's engine.
