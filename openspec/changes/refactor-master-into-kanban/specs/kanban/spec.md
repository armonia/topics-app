## ADDED Requirements

### Requirement: KANBAN-MASTER-01 — Master proposals surface as kanban cards

The system SHALL turn the Master's `## Next` proposals (verbs `COMPLETA` / `APRI`) into cards in the persistent kanban (`tasks` table), linking each card to the originating session via `tasks.assigned_topic_id` and recording the proposal in `task_events`. The standalone `MasterBoardStrip` SHALL be removed as a separate UI.

#### Scenario: An APRI proposal becomes an actionable card
- **GIVEN** an open global Master
- **WHEN** the Master emits a `## Next` block containing `APRI **<session>** — <concrete action>`
- **THEN** a proposal card appears in the kanban with the concrete action as its text
- **AND** the card's `assigned_topic_id` equals the referenced session/topic id
- **AND** a `task_events` row exists with `type = 'proposal'` for that session

#### Scenario: Re-emitting the same proposal does not duplicate
- **GIVEN** a proposal card already exists for a `(verb, session, reason)` triple
- **WHEN** the Master emits the same proposal again
- **THEN** the existing card is updated rather than a second card created
- **AND** the `idx_tasks_claude_task_id` unique index is respected (stable `claude_task_id` hash)

#### Scenario: A COMPLETA proposal resolves the linked card
- **GIVEN** a proposal card linked to a session
- **WHEN** the Master emits `COMPLETA **<session>**` for that session
- **THEN** the linked card moves to `done`
- **AND** the resolution is reversible (the card can be restored)

#### Scenario: Clicking a proposal card jumps to its session
- **GIVEN** a proposal card linked to a session pane
- **WHEN** the user clicks the card
- **THEN** the corresponding session pane is focused (via `assigned_topic_id`)

#### Scenario: Global proposals land on a board even without a project
- **GIVEN** the referenced session has no `project_path` (e.g. a standalone `claude-code` terminal)
- **WHEN** a proposal card is created for it
- **THEN** the card is assigned to a synthetic global board id (satisfying the NOT NULL `tasks.project_id`)
- **AND** the card is visible in the cross-project `AllBoardsPane`

#### Scenario: Malformed proposal rows are skipped, not fatal
- **GIVEN** the Master emits a `## Next` block with one malformed row and one valid row
- **WHEN** the server parses the block
- **THEN** the valid row produces a card
- **AND** the malformed row is ignored without throwing

#### Scenario: Closing a linked session auto-resolves its proposal
- **GIVEN** a proposal card linked to a session
- **WHEN** that session/topic is archived or closed
- **THEN** the linked proposal card is auto-resolved to `done`
