## ADDED Requirements

### Requirement: Server purges archived topic ids from persisted ui state
When a topic is archived (single or bulk), the server SHALL remove that topic id from every `ui_state` record's `openChatTopicIds` array AND clear `activeChatTopicId` if it referenced the archived topic. Each mutated key SHALL be broadcast as `ui-state:updated` so clients reconcile without a full reload.

#### Scenario: Archive removes phantom id from ui_state
- **GIVEN** a `ui_state` record for project P has `openChatTopicIds: [topic-A, topic-B]`
- **WHEN** topic-A is archived via `DELETE /api/topics/topic-A`
- **THEN** the same `ui_state` record SHALL have `openChatTopicIds: [topic-B]`
- **AND** a `ui-state:updated` broadcast SHALL be sent with the new value
- **AND** a subsequent `GET /api/ui-state/{key}` SHALL not contain topic-A

#### Scenario: Bulk archive purges all referenced ids
- **WHEN** `POST /api/topics/bulk-archive` archives multiple topics
- **THEN** every affected topic id SHALL be purged from all ui_state records that reference it

### Requirement: New top-level utility panes auto-solo
When a new top-level utility pane (terminal, browser) is created via the quick-create entry point AND there are already other panels open, the pane SHALL be marked solo so it lands in its own grid cell instead of merging into the standalone group with mixed-type tabs.

#### Scenario: New terminal with existing panels gets own cell
- **GIVEN** the user has openPanels = [project-A] (visible as standalone group)
- **WHEN** the user clicks "New Claude Code" from the quick-create menu
- **THEN** the new `terminal:{id}` pane SHALL be added to soloTopicIds
- **AND** the grid SHALL render two cells: standalone (project-A) and the new terminal in its own cell

#### Scenario: New terminal as first pane stays normal
- **GIVEN** openPanels is empty
- **WHEN** the user clicks "New Claude Code"
- **THEN** the new pane SHALL NOT be marked solo (single pane needs no special handling)

### Requirement: Cleanup timer is cancellable on undo
When a pane is scheduled for server-side deletion via a 60s timeout, the timeout handle SHALL be stored on the pane record. Any undo or restore operation SHALL cancel the timeout before the 60s elapse.

#### Scenario: Undo cancels deletion
- **GIVEN** a terminal pane is closed and scheduled for deletion in 60s
- **WHEN** the user undoes the close within 5s
- **THEN** the cleanup timeout SHALL be cancelled
- **AND** the pane SHALL persist on the server after 70s

#### Scenario: Normal deletion proceeds without undo
- **GIVEN** a terminal pane is closed
- **WHEN** no undo happens within 60s
- **THEN** the pane SHALL be removed from the server
