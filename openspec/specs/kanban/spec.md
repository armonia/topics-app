## Purpose

Specifies behavioral scenarios for the Kanban board system including board rendering, task CRUD, drag-drop reordering, approval workflows, filters, agent assignment, board settings, and multi-board views.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic with a linked project folder exists and is selected
- The kanban board pane is visible with columns loaded
## Requirements
### Requirement: KANBAN-01 — Board Rendering, Task CRUD & Drag-Drop

The system SHALL render a kanban board with five status columns, support creating, viewing, editing, and deleting tasks, and allow drag-drop to move or reorder tasks.

#### Scenario: Board renders with all five columns
- **GIVEN** the kanban board is loaded for a project
- **WHEN** the board finishes loading
- **THEN** five columns are visible: Backlog, Todo, In Progress, Review, and Done

#### Scenario: Column headers show labels and task counts
- **GIVEN** the board has tasks distributed across multiple columns
- **WHEN** the board renders
- **THEN** each column header displays its label
- **AND** each column header shows a count of tasks in that column

#### Scenario: Create new task via inline input
- **GIVEN** a column is visible on the board
- **WHEN** the user clicks the Add button in the column
- **THEN** an inline text input appears in that column
- **AND** after typing a task description and pressing Enter the new task appears in the column

#### Scenario: Task card displays summary information
- **GIVEN** a task exists in a column
- **WHEN** the board renders
- **THEN** the task card shows the task description text

#### Scenario: Task card shows priority indicator
- **GIVEN** a task has a priority level assigned
- **WHEN** the board renders
- **THEN** the task card displays a visual priority indicator

#### Scenario: Task card shows assigned agent badge
- **GIVEN** a task is assigned to an agent
- **WHEN** the board renders
- **THEN** the task card displays the assigned agent name or badge

> Note: Agent assignment on task cards is also relevant to AGENT-02 (topic assignment and status indicators).

#### Scenario: Task detail panel opens on card click
- **GIVEN** a task card is visible on the board
- **WHEN** the user clicks on the task card
- **THEN** a detail panel opens showing the full task information
- **AND** the panel contains the task description

#### Scenario: Edit task description in detail panel
- **GIVEN** the task detail panel is open
- **WHEN** the user clicks on the description area and types a new description
- **AND** clicks the Save button
- **THEN** the updated description is saved and visible in the detail panel

#### Scenario: Delete task from detail panel
- **GIVEN** the task detail panel is open for a task
- **WHEN** the user clicks the delete or archive action
- **THEN** the task is removed from the board column

#### Scenario: Drag task between columns changes status
- **GIVEN** a task is in the Todo column
- **WHEN** the user drags the task card to the In Progress column
- **THEN** the task moves to the In Progress column
- **AND** the task is no longer visible in the Todo column

#### Scenario: Drag reorder tasks within a column
- **GIVEN** a column contains multiple tasks
- **WHEN** the user drags a task above another task in the same column
- **THEN** the task order within the column changes to reflect the new position

#### Scenario: Loading state while board fetches data
- **GIVEN** the user navigates to a project board
- **WHEN** the board data is being fetched
- **THEN** a loading indicator is displayed until the board renders

#### Scenario: Error state when board fails to load
- **GIVEN** the board data fetch encounters a network or server error
- **WHEN** the board attempts to render
- **THEN** an error message or empty state is displayed instead of columns

> Note: Error state behavior has limited E2E test coverage; may be a gap.

#### Scenario: Real-time update when another user creates a task
- **GIVEN** the board is open and connected via WebSocket
- **WHEN** another user or agent creates a task in the same project
- **THEN** the new task appears on the board without requiring a manual refresh

#### Scenario: Real-time update when another user moves a task
- **GIVEN** the board is open and connected via WebSocket
- **WHEN** another user or agent moves a task to a different column
- **THEN** the board reflects the new column placement without requiring a manual refresh

> Note: WebSocket broadcast for board updates is also relevant to real-time sync behavior across the app.

#### Scenario: Task card has drag handle for reordering
- **GIVEN** a task card is visible on the board
- **WHEN** the user looks at the task card
- **THEN** a drag handle element is visible for initiating drag operations

### Requirement: KANBAN-02 — Workflows -- Approvals, Filters, Agent Assignment & Settings

The system SHALL support approval workflows for task transitions, filtering tasks by status/priority/agent, managing board settings, board memory entries, and viewing tasks across multiple project boards.

#### Scenario: Approval banner visible on tasks pending approval
- **GIVEN** a task has a pending approval for a status transition
- **WHEN** the board renders
- **THEN** the task card displays an approval required banner

#### Scenario: Review button opens approval modal
- **GIVEN** a task card shows an approval required banner
- **WHEN** the user clicks the Review button on the banner
- **THEN** an approval review modal opens

#### Scenario: Approval modal shows confidence score and justification
- **GIVEN** the approval review modal is open
- **WHEN** the modal content loads
- **THEN** the modal displays the confidence score as a percentage
- **AND** the modal displays the justification text

#### Scenario: Approve action closes modal and moves task
- **GIVEN** the approval review modal is open with Approve and Reject buttons visible
- **WHEN** the user clicks the Approve button
- **THEN** the modal closes
- **AND** the task transitions to the target status column

#### Scenario: Reject action closes modal and returns task
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the Reject button
- **THEN** the modal closes
- **AND** the task remains in its current column

#### Scenario: Status filter narrows visible tasks
- **GIVEN** the board has tasks in multiple columns
- **WHEN** the user selects a specific status from the status filter dropdown
- **THEN** only tasks matching that status are visible
- **AND** tasks in other columns are hidden

#### Scenario: Priority filter shows only matching priority
- **GIVEN** the board has tasks with different priority levels
- **WHEN** the user selects a priority level from the priority filter dropdown
- **THEN** only tasks with the matching priority are visible
- **AND** tasks with other priorities are hidden

#### Scenario: Agent filter shows only assigned tasks
- **GIVEN** the board has tasks assigned to different agents and some unassigned
- **WHEN** the user types an agent name in the assigned-to filter input
- **THEN** only tasks assigned to that agent are visible
- **AND** unassigned tasks and tasks assigned to other agents are hidden

#### Scenario: Clear filters button resets all filters
- **GIVEN** one or more filters are active on the board
- **WHEN** the user clicks the Clear filters button
- **THEN** all filters are reset
- **AND** all tasks across all columns become visible again

#### Scenario: Board settings panel opens via gear button
- **GIVEN** the board is rendered
- **WHEN** the user clicks the settings gear button
- **THEN** the board settings panel opens

#### Scenario: Toggle require approval setting
- **GIVEN** the board settings panel is open
- **WHEN** the user toggles the "Require approval to mark as Done" checkbox
- **THEN** the checkbox state changes to reflect the new value

#### Scenario: Board settings persist after close and reopen
- **GIVEN** the user has toggled a setting and saved
- **WHEN** the user closes and reopens the board settings panel
- **THEN** the previously toggled setting retains its saved value

#### Scenario: Cancel settings discards changes
- **GIVEN** the board settings panel is open with unsaved changes
- **WHEN** the user clicks the Cancel button
- **THEN** the settings panel closes without saving the changes

#### Scenario: Board memory panel shows entries
- **GIVEN** a board has memory entries stored
- **WHEN** the user opens the Board Memory pane
- **THEN** the memory entries are listed with their content

#### Scenario: Add new memory entry with tags
- **GIVEN** the Board Memory pane is open
- **WHEN** the user types a memory entry in the textarea and fills in comma-separated tags
- **AND** clicks the Save button
- **THEN** the new memory entry appears in the memory list

#### Scenario: AllBoardsPane shows tasks across multiple projects
- **GIVEN** multiple projects have kanban boards with tasks
- **WHEN** the user navigates to the All Boards view
- **THEN** tasks from all projects are visible in a combined view

#### Scenario: Project label badges on cards in AllBoardsPane
- **GIVEN** the All Boards view is showing tasks from multiple projects
- **WHEN** the user views task cards
- **THEN** each task card displays a project label badge indicating which project it belongs to

#### Scenario: Task escalation indicator on card
- **GIVEN** a task has been escalated
- **WHEN** the board renders
- **THEN** the task card displays an escalation indicator

> Note: Task escalation feature exists in the source code but has limited E2E test coverage; may be a gap.

#### Scenario: Dismiss escalation on task
- **GIVEN** a task card shows an escalation indicator
- **WHEN** the user dismisses the escalation
- **THEN** the escalation indicator is removed from the task card

> Note: Escalation dismissal exists in the source code but has limited E2E test coverage; may be a gap.

### Requirement: KANBAN-03 — Board Memory & Tags

The system SHALL provide a board memory panel that lists stored memory entries with tags, supports adding new entries with comma-separated tags, displays entry metadata with timestamps and source, synchronizes in real-time via WebSocket, and shows an empty state when no entries exist.

#### Scenario: Board memory panel displays entry count in header
- **GIVEN** the board memory panel is open for a project
- **WHEN** memory entries exist
- **THEN** the header shows "Board Memory" with a count in parentheses (e.g., "(5)")

#### Scenario: Memory entries display content and tags
- **GIVEN** memory entries are loaded in the board memory panel
- **WHEN** the entries render
- **THEN** each entry shows its text content in a bordered card
- **AND** each entry displays its tags as colored badges above the content
- **AND** tag colors are assigned based on tag name (decision=amber, plan=blue, handoff=purple, summary=green)

#### Scenario: Memory entries show relative timestamp and source
- **GIVEN** memory entries are displayed
- **WHEN** the user views an entry
- **THEN** a relative timestamp appears (e.g., "5m ago", "2h ago")
- **AND** the source label (e.g., "user") is displayed if present

#### Scenario: Empty state shown when no memory entries exist
- **GIVEN** the board memory panel is open
- **WHEN** no memory entries have been stored
- **THEN** an italic placeholder message is displayed: "No memory entries yet. Agents will store decisions, plans, and handoffs here."

#### Scenario: Adding a memory entry with content and tags
- **GIVEN** the board memory panel is open
- **WHEN** the user types content in the textarea and enters comma-separated tags in the tags input
- **AND** clicks the "Save" button
- **THEN** the entry is created via boardMemoryApi.create with the content, parsed tags, and source "user"
- **AND** the textarea and tags input clear after successful save
- **AND** a "Saved" confirmation appears briefly

#### Scenario: Save button is disabled when content is empty
- **GIVEN** the board memory panel add form is visible
- **WHEN** the content textarea is empty
- **THEN** the Save button is disabled with reduced opacity
- **AND** clicking it has no effect

#### Scenario: Keyboard shortcut submits memory entry
- **GIVEN** the content textarea has text entered
- **WHEN** the user presses Cmd+Enter (or Ctrl+Enter)
- **THEN** the memory entry is submitted without clicking the Save button

#### Scenario: Save error displays temporary error message
- **GIVEN** the user submits a new memory entry
- **WHEN** the API call fails
- **THEN** a red "Failed to save memory" error message appears
- **AND** the error message disappears after 3 seconds

#### Scenario: WebSocket message adds new entry in real-time
- **GIVEN** the board memory panel is open and connected via WebSocket
- **WHEN** a "board:memory_added" WebSocket message arrives for the same project
- **THEN** the new memory entry appears at the top of the memory list without a manual refresh

#### Scenario: Refresh button reloads memory entries
- **GIVEN** the board memory panel is open
- **WHEN** the user clicks the refresh button in the header
- **THEN** the memory entries are reloaded from the server
- **AND** the refresh icon spins during loading

### Requirement: KANBAN-04 — Extended Approvals

**Status: NOT BUILT** — The extended approval modal does not exist: no `rubricScores`, `confidenceScore` or `justification` anywhere in the client, and no `/api/approvals` route. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide an approval review modal that displays task information, status transition, confidence score as a percentage bar, rubric scores, justification text, an optional reviewer comment field, and Approve/Reject action buttons with metadata.

#### Scenario: Approval modal displays task information
- **GIVEN** the approval review modal is open
- **WHEN** the modal content renders
- **THEN** the task text or task ID is displayed under a "Task" heading
- **AND** the modal title reads "Review Approval"

#### Scenario: Approval modal shows status transition
- **GIVEN** the approval has fromStatus and toStatus fields
- **WHEN** the modal renders
- **THEN** a "Status Change" section shows the transition as "fromStatus -> toStatus"
- **AND** the target status is displayed in bold

#### Scenario: Confidence score renders as percentage bar
- **GIVEN** the approval has a confidenceScore value
- **WHEN** the modal renders
- **THEN** a horizontal progress bar fills to the confidence percentage width
- **AND** the rounded percentage number is displayed next to the bar (e.g., "85%")

#### Scenario: Rubric scores display category ratings
- **GIVEN** the approval has rubricScores with multiple categories
- **WHEN** the modal renders
- **THEN** each rubric category is listed with its name and score out of 5
- **AND** a "Rubric Scores" section header with a bar chart icon is visible

#### Scenario: Justification text is displayed in formatted area
- **GIVEN** the approval has justification text
- **WHEN** the modal renders
- **THEN** the justification appears under a "Justification" heading
- **AND** the text preserves whitespace and wrapping in a styled container

#### Scenario: Reviewer can add an optional comment
- **GIVEN** the approval review modal is open
- **WHEN** the user types text in the comment textarea
- **THEN** the comment text is captured
- **AND** the comment is passed to the approve or reject callback when an action is taken

#### Scenario: Approve button calls onApprove with ID and comment
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the "Approve" button
- **THEN** the onApprove callback is invoked with the approval ID and the optional comment
- **AND** the button displays a shield-check icon next to "Approve"

#### Scenario: Reject button calls onReject with ID and comment
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the "Reject" button
- **THEN** the onReject callback is invoked with the approval ID and the optional comment
- **AND** the button displays a shield-x icon with red styling

#### Scenario: Escape key closes the approval modal
- **GIVEN** the approval review modal is open
- **WHEN** the user presses the Escape key
- **THEN** the modal closes via the onClose callback

#### Scenario: Clicking backdrop closes the approval modal
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks on the dark overlay outside the modal content
- **THEN** the modal closes via the onClose callback

#### Scenario: Modal shows requester and timestamp metadata
- **GIVEN** the approval review modal is open
- **WHEN** the user views the footer area
- **THEN** the text "Requested by [name]" is displayed with the creation timestamp
- **AND** if an expiration date exists it is shown as "Expires [date]"

### Requirement: KANBAN-10 — Ripresa del dispatch al riavvio del server

Un riavvio del server (deploy, hot-reload, crash) SHALL essere trasparente per i task in
lavorazione: un task `in_progress` con chip `working` e un topic ancora esistente SHALL
essere **ripreso sulla stessa sessione** (stesso topic, stesso worktree, conversazione
CLI ripresa via `--resume`) con un nudge di continuazione lean — MAI un release+re-claim
che crea un topic e un worktree nuovi e fa ripartire l'agent da zero (stesso principio
del post-timeout in KANBAN-07, esteso al riavvio). La ripresa SHALL lasciare un commento
di sistema nel thread e NON SHALL consumare un tentativo del retry-cap: il riavvio non è
mai colpa dell'agent.

Il requeue da zero (release + ritorno in `todo` con rollback del tentativo) resta SOLO
per gli orfani che non hanno una sessione da riprendere: binding assente (crash tra
claim e bind), topic morto (ripulito durante il downtime), chip `starting` (kickoff mai
partito). Con l'interruttore globale `auto_dispatch` spento nessuna ripresa SHALL
avvenire: l'orfano torna in `todo` senza chip (su una board che non dispatcha un chip
`queued` non deve strandare). La riconciliazione SHALL essere idempotente sotto il poll
periodico: un turno già ripreso non viene mai raddoppiato.

#### Scenario: riavvio con agent al lavoro → riprende, non riparte
- **GIVEN** un task `in_progress` chip `working` legato a un topic esistente, board con auto-dispatch attivo
- **WHEN** il server riparte e la riconciliazione gira
- **THEN** il task resta `in_progress` legato allo STESSO topic e un turno di continuazione parte sulla stessa sessione
- **AND** i tentativi non aumentano e nel thread compare un commento di sistema sul riavvio

#### Scenario: orfano senza sessione riprendibile → requeue senza consumare tentativi
- **GIVEN** un task `in_progress` mid-dispatch il cui topic non esiste più (o mai legato)
- **WHEN** la riconciliazione gira
- **THEN** il task torna in `todo` senza binding e il tentativo interrotto è rimborsato

#### Scenario: auto-dispatch spento durante il downtime
- **GIVEN** un task `in_progress` chip `working` e l'interruttore globale spento
- **WHEN** la riconciliazione gira
- **THEN** il task torna in `todo` senza chip di dispatch e nessun agent riparte

#### Scenario: poll di riconciliazione non raddoppia i turni
- **GIVEN** un task appena ripreso con il turno ancora in corso
- **WHEN** la riconciliazione periodica rigira
- **THEN** nessun secondo turno parte per quel task
