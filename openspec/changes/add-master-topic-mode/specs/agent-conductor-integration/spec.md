## Purpose

Specifies the integration of `agent-conductor` as a library dependency: side-car observer, deterministic status enrichment, cwd-collision detection, and macOS Reminders bridge.

## Background

Common preconditions:
- `agent-conductor` is installed as a workspace dependency or sibling repo
- On macOS, `remindctl` is installed and authorized (for Reminders features only)

## Requirements

### Requirement: AC-01 — Observer enrichment of topic badges

The system SHALL use `agent-conductor`'s `discover()` and `deriveStatus()` to enrich topic-pane status badges with deterministic state (working/awaiting-input/idle/crashed).

#### Scenario: Topic badge reflects deterministic status
- **GIVEN** a topic has an active `claude` PTY session
- **WHEN** the badge renders
- **THEN** the status is derived from `agent-conductor`'s `deriveStatus()` (not heuristics local to Topics)
- **AND** the badge updates within 2s of state change

### Requirement: AC-02 — Cwd-collision warning

The system SHALL surface a UI warning when two topics target the same project working directory at the same time.

#### Scenario: Two topics on same cwd shows warning
- **GIVEN** topic A and topic B both have an active session with the same `cwd`
- **WHEN** both panes are visible
- **THEN** a non-blocking warning banner appears on both panes
- **AND** the banner text explains the collision and links to docs

### Requirement: AC-03 — Reminders bridge (macOS only)

The system SHALL optionally bridge macOS Reminders into the kanban board, creating tasks for new reminders and marking reminders complete when tasks finish.

#### Scenario: New reminder creates kanban task
- **GIVEN** the Reminders bridge is enabled in settings
- **WHEN** the user adds a new reminder via Siri/Watch/iPhone in the configured list
- **THEN** within 30s a new task appears in the Backlog column with `source='reminders'`
- **AND** the reminder's GUID is stored to dedupe future polls

#### Scenario: Task completion marks reminder done
- **GIVEN** a kanban task with `source='reminders'` is moved to Done
- **WHEN** the move is committed
- **THEN** within 30s the corresponding reminder is marked complete via `remindctl`

#### Scenario: Bridge degrades gracefully when remindctl missing
- **GIVEN** `remindctl` is not installed or unauthorized
- **WHEN** the user enables the Reminders bridge
- **THEN** the settings page shows a clear banner explaining the dependency
- **AND** Topics functionality is otherwise unaffected
