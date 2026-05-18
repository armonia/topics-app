## Delta vs base `kanban/spec.md`

Adds task ↔ topic binding and jump-to-tab behaviour. Existing scenarios remain valid.

## Requirements

### Requirement: KANBAN-DELTA-01 — Task-Topic binding

The system SHALL bind each task to an `assigned_topic_id` when spawned by a Master Topic and display the binding in the card UI.

#### Scenario: Card shows teammate Topic badge when assigned
- **GIVEN** a task in the kanban board has `assigned_topic_id` set
- **WHEN** the card renders
- **THEN** a clickable badge with the teammate Topic name is visible on the card
- **AND** the badge color reflects the teammate's current status (working/awaiting-review/idle)

#### Scenario: Click on assignment badge jumps to teammate pane
- **GIVEN** a task card with an assignment badge
- **WHEN** the user clicks the badge
- **THEN** the layout focuses the teammate Topic pane
- **AND** the pane scrolls to the latest output

### Requirement: KANBAN-DELTA-02 — Shared task list sync

The system SHALL mirror Claude Code's shared task list (file under `~/.claude/projects/<hash>/tasks/`) into the kanban board within 2 seconds of change, and write back local edits to the shared list.

#### Scenario: Claude writes task → board renders within 2s
- **GIVEN** the Master Topic is active
- **WHEN** the lead writes a new task to the shared task list file
- **THEN** within 2 seconds a corresponding card appears in the Backlog column
- **AND** the card carries the matching `claude_task_id`

#### Scenario: Board edit writes back to shared list
- **GIVEN** a task on the board has `claude_task_id` set
- **WHEN** the user edits the task title in the board
- **THEN** within 2 seconds the corresponding JSON file is updated
- **AND** the modification timestamp reflects the change

#### Scenario: Conflict resolution prefers last-write-wins
- **GIVEN** a task is edited simultaneously in the board and by claude
- **WHEN** both writes occur within 1s of each other
- **THEN** the write with the latest timestamp wins
- **AND** a non-blocking toast warns the user of the collision
