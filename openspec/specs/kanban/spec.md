# Kanban Board

**Purpose:** Specifies behavioral scenarios for the Kanban board system including board rendering, task CRUD, drag-drop reordering, approval workflows, filters, agent assignment, board settings, and multi-board views.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic with a linked project folder exists and is selected
- The kanban board pane is visible with columns loaded

## Requirements

### KANBAN-01: Board Rendering, Task CRUD & Drag-Drop

The system SHALL render a kanban board with five status columns, support creating, viewing, editing, and deleting tasks, and allow drag-drop to move or reorder tasks.

#### Scenario: Board renders with all five columns
- GIVEN the kanban board is loaded for a project
- WHEN the board finishes loading
- THEN five columns are visible: Backlog, Todo, In Progress, Review, and Done

#### Scenario: Column headers show labels and task counts
- GIVEN the board has tasks distributed across multiple columns
- WHEN the board renders
- THEN each column header displays its label
- AND each column header shows a count of tasks in that column

#### Scenario: Create new task via inline input
- GIVEN a column is visible on the board
- WHEN the user clicks the Add button in the column
- THEN an inline text input appears in that column
- AND after typing a task description and pressing Enter the new task appears in the column

#### Scenario: Task card displays summary information
- GIVEN a task exists in a column
- WHEN the board renders
- THEN the task card shows the task description text

#### Scenario: Task card shows priority indicator
- GIVEN a task has a priority level assigned
- WHEN the board renders
- THEN the task card displays a visual priority indicator

#### Scenario: Task card shows assigned agent badge
- GIVEN a task is assigned to an agent
- WHEN the board renders
- THEN the task card displays the assigned agent name or badge

> Note: Agent assignment on task cards is also relevant to AGENT-02 (topic assignment and status indicators).

#### Scenario: Task detail panel opens on card click
- GIVEN a task card is visible on the board
- WHEN the user clicks on the task card
- THEN a detail panel opens showing the full task information
- AND the panel contains the task description

#### Scenario: Edit task description in detail panel
- GIVEN the task detail panel is open
- WHEN the user clicks on the description area and types a new description
- AND clicks the Save button
- THEN the updated description is saved and visible in the detail panel

#### Scenario: Delete task from detail panel
- GIVEN the task detail panel is open for a task
- WHEN the user clicks the delete or archive action
- THEN the task is removed from the board column

#### Scenario: Drag task between columns changes status
- GIVEN a task is in the Todo column
- WHEN the user drags the task card to the In Progress column
- THEN the task moves to the In Progress column
- AND the task is no longer visible in the Todo column

#### Scenario: Drag reorder tasks within a column
- GIVEN a column contains multiple tasks
- WHEN the user drags a task above another task in the same column
- THEN the task order within the column changes to reflect the new position

#### Scenario: Loading state while board fetches data
- GIVEN the user navigates to a project board
- WHEN the board data is being fetched
- THEN a loading indicator is displayed until the board renders

#### Scenario: Error state when board fails to load
- GIVEN the board data fetch encounters a network or server error
- WHEN the board attempts to render
- THEN an error message or empty state is displayed instead of columns

> Note: Error state behavior has limited E2E test coverage; may be a gap.

#### Scenario: Real-time update when another user creates a task
- GIVEN the board is open and connected via WebSocket
- WHEN another user or agent creates a task in the same project
- THEN the new task appears on the board without requiring a manual refresh

#### Scenario: Real-time update when another user moves a task
- GIVEN the board is open and connected via WebSocket
- WHEN another user or agent moves a task to a different column
- THEN the board reflects the new column placement without requiring a manual refresh

> Note: WebSocket broadcast for board updates is also relevant to real-time sync behavior across the app.

#### Scenario: Task card has drag handle for reordering
- GIVEN a task card is visible on the board
- WHEN the user looks at the task card
- THEN a drag handle element is visible for initiating drag operations

### KANBAN-02: Workflows -- Approvals, Filters, Agent Assignment & Settings

The system SHALL support approval workflows for task transitions, filtering tasks by status/priority/agent, managing board settings, board memory entries, and viewing tasks across multiple project boards.

#### Scenario: Approval banner visible on tasks pending approval
- GIVEN a task has a pending approval for a status transition
- WHEN the board renders
- THEN the task card displays an approval required banner

#### Scenario: Review button opens approval modal
- GIVEN a task card shows an approval required banner
- WHEN the user clicks the Review button on the banner
- THEN an approval review modal opens

#### Scenario: Approval modal shows confidence score and justification
- GIVEN the approval review modal is open
- WHEN the modal content loads
- THEN the modal displays the confidence score as a percentage
- AND the modal displays the justification text

#### Scenario: Approve action closes modal and moves task
- GIVEN the approval review modal is open with Approve and Reject buttons visible
- WHEN the user clicks the Approve button
- THEN the modal closes
- AND the task transitions to the target status column

#### Scenario: Reject action closes modal and returns task
- GIVEN the approval review modal is open
- WHEN the user clicks the Reject button
- THEN the modal closes
- AND the task remains in its current column

#### Scenario: Status filter narrows visible tasks
- GIVEN the board has tasks in multiple columns
- WHEN the user selects a specific status from the status filter dropdown
- THEN only tasks matching that status are visible
- AND tasks in other columns are hidden

#### Scenario: Priority filter shows only matching priority
- GIVEN the board has tasks with different priority levels
- WHEN the user selects a priority level from the priority filter dropdown
- THEN only tasks with the matching priority are visible
- AND tasks with other priorities are hidden

#### Scenario: Agent filter shows only assigned tasks
- GIVEN the board has tasks assigned to different agents and some unassigned
- WHEN the user types an agent name in the assigned-to filter input
- THEN only tasks assigned to that agent are visible
- AND unassigned tasks and tasks assigned to other agents are hidden

#### Scenario: Clear filters button resets all filters
- GIVEN one or more filters are active on the board
- WHEN the user clicks the Clear filters button
- THEN all filters are reset
- AND all tasks across all columns become visible again

#### Scenario: Board settings panel opens via gear button
- GIVEN the board is rendered
- WHEN the user clicks the settings gear button
- THEN the board settings panel opens

#### Scenario: Toggle require approval setting
- GIVEN the board settings panel is open
- WHEN the user toggles the "Require approval to mark as Done" checkbox
- THEN the checkbox state changes to reflect the new value

#### Scenario: Board settings persist after close and reopen
- GIVEN the user has toggled a setting and saved
- WHEN the user closes and reopens the board settings panel
- THEN the previously toggled setting retains its saved value

#### Scenario: Cancel settings discards changes
- GIVEN the board settings panel is open with unsaved changes
- WHEN the user clicks the Cancel button
- THEN the settings panel closes without saving the changes

#### Scenario: Board memory panel shows entries
- GIVEN a board has memory entries stored
- WHEN the user opens the Board Memory pane
- THEN the memory entries are listed with their content

#### Scenario: Add new memory entry with tags
- GIVEN the Board Memory pane is open
- WHEN the user types a memory entry in the textarea and fills in comma-separated tags
- AND clicks the Save button
- THEN the new memory entry appears in the memory list

#### Scenario: AllBoardsPane shows tasks across multiple projects
- GIVEN multiple projects have kanban boards with tasks
- WHEN the user navigates to the All Boards view
- THEN tasks from all projects are visible in a combined view

#### Scenario: Project label badges on cards in AllBoardsPane
- GIVEN the All Boards view is showing tasks from multiple projects
- WHEN the user views task cards
- THEN each task card displays a project label badge indicating which project it belongs to

#### Scenario: Task escalation indicator on card
- GIVEN a task has been escalated
- WHEN the board renders
- THEN the task card displays an escalation indicator

> Note: Task escalation feature exists in the source code but has limited E2E test coverage; may be a gap.

#### Scenario: Dismiss escalation on task
- GIVEN a task card shows an escalation indicator
- WHEN the user dismisses the escalation
- THEN the escalation indicator is removed from the task card

> Note: Escalation dismissal exists in the source code but has limited E2E test coverage; may be a gap.
