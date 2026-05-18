## Purpose

Specifies behavioral scenarios for Master Topic mode: a topic running as the lead in Claude Code Agent Teams, orchestrating teammate topics that work on multi-project tasks.

## Background

Common preconditions:
- The user is logged into Topics App at http://localhost:3333
- `claude` CLI is installed and authenticated to a Pro/Max subscription
- At least one project folder exists and is registered

## Requirements

### Requirement: MASTER-01 — Master Topic creation via CLI

The system SHALL allow creating a Master Topic via `topics master --project <path>`, spawning a `claude` session with the Agent Teams experimental flag enabled.

#### Scenario: User opens Master Topic via CLI
- **GIVEN** the user has a registered project folder
- **WHEN** the user runs `topics master --project ~/Projects/microgeo`
- **THEN** Topics opens in the default browser at `/master/<id>`
- **AND** a Master Topic pane is visible with an active `claude` session
- **AND** the spawned process has `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in its environment
- **AND** the topic has `agent_team_role='lead'`

#### Scenario: Resuming an existing Master Topic
- **GIVEN** a Master Topic exists for project `~/Projects/microgeo`
- **WHEN** the user runs `topics master --project ~/Projects/microgeo` again
- **THEN** Topics focuses the existing Master Topic instead of creating a duplicate
- **AND** the existing `claude` session is resumed via `--resume <session-id>`

#### Scenario: Master Topic UI shows team-mode badge
- **GIVEN** a Master Topic is open
- **WHEN** the pane header renders
- **THEN** a "Team Mode" badge is visible next to the topic title
- **AND** the shared task list sidebar is visible

### Requirement: MASTER-02 — Teammate spawn and binding

The system SHALL spawn teammate Topics when the lead delegates work, binding each teammate to its parent Master Topic and to the project's `cwd`.

#### Scenario: Lead delegates triggers teammate spawn
- **GIVEN** a Master Topic with an active claude session
- **WHEN** the lead emits a delegation event (stream-json `agent_spawn` or shared task list write)
- **THEN** a new teammate Topic is created with `parent_topic_id` equal to the Master Topic id
- **AND** the teammate's `agent_team_role` is `'teammate'`
- **AND** the teammate's `cwd` matches the delegated project path
- **AND** the teammate appears as a new pane in the Master's layout

#### Scenario: Teammate pane shows assigned task
- **GIVEN** a teammate Topic exists and has been assigned a task
- **WHEN** the pane renders
- **THEN** the task title is shown in the pane header
- **AND** a status badge reflects the teammate's current activity (thinking, tool use, idle, awaiting review)

### Requirement: MASTER-03 — Token budget guardrail

The system SHALL warn the user when active teammate count exceeds 3 on a Claude Pro plan, recommending Max upgrade or fewer concurrent teammates.

#### Scenario: Pro user spawns fourth concurrent teammate
- **GIVEN** the user has 3 active teammate Topics under a Master
- **WHEN** the lead attempts to spawn a fourth teammate
- **THEN** a non-blocking warning banner appears in the Master pane
- **AND** the warning text mentions weekly limit and upgrade path
- **AND** the user can dismiss or proceed
