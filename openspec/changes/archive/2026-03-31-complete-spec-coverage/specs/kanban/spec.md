## ADDED Requirements

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
