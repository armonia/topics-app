## ADDED Requirements

### Requirement: CHAT-05 — Checkpoints

The system SHALL support creating conversation checkpoints as snapshots, displaying them in a compact timeline view, expanding to see checkpoint details, and rolling back to a previous checkpoint with confirmation.

#### Scenario: Checkpoint bar shows count and timeline dots
- **GIVEN** a topic has one or more saved checkpoints
- **WHEN** the checkpoint timeline component renders
- **THEN** a compact bar displays the checkpoint count (e.g., "3 checkpoints")
- **AND** small colored dots represent the most recent checkpoints (up to 8)
- **AND** dots with a git hash appear in primary color while others use placeholder color

#### Scenario: Checkpoint bar is hidden when no checkpoints exist
- **GIVEN** a topic has no saved checkpoints
- **WHEN** the checkpoint timeline component renders
- **THEN** the component renders nothing (no bar is visible)

#### Scenario: Clicking checkpoint bar expands the timeline
- **GIVEN** the compact checkpoint bar is visible
- **WHEN** the user clicks the bar
- **THEN** the timeline expands to show a detailed list of all checkpoints
- **AND** the bar label changes from "Show" to "Hide"

#### Scenario: Expanded timeline lists checkpoint details
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** checkpoint entries are displayed
- **THEN** each entry shows a colored dot, description text, relative timestamp, and message count
- **AND** checkpoints with a git hash show the abbreviated hash in primary color

#### Scenario: Save button creates a new checkpoint
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** the user clicks the "Save" button with the Plus icon
- **THEN** a new checkpoint is created via the API
- **AND** the new checkpoint appears at the bottom of the timeline list

#### Scenario: Hovering a checkpoint reveals rollback button
- **GIVEN** the checkpoint timeline is expanded with entries listed
- **WHEN** the user hovers over a checkpoint entry
- **THEN** a rollback button (rotate-ccw icon) appears on the right side of the entry
- **AND** the entry background highlights on hover

#### Scenario: Clicking rollback shows confirmation dialog
- **GIVEN** the rollback button is visible on a checkpoint entry
- **WHEN** the user clicks the rollback button
- **THEN** a browser confirmation dialog appears explaining the rollback action
- **AND** the dialog mentions the checkpoint description and message count
- **AND** if a git hash exists the dialog mentions the abbreviated git hash

#### Scenario: Confirming rollback truncates to checkpoint
- **GIVEN** the rollback confirmation dialog is displayed
- **WHEN** the user confirms the dialog
- **THEN** the checkpoint list truncates to include only checkpoints up to and including the selected one
- **AND** later checkpoints are removed from the timeline

#### Scenario: Cancelling rollback preserves current state
- **GIVEN** the rollback confirmation dialog is displayed
- **WHEN** the user cancels the dialog
- **THEN** no rollback occurs
- **AND** the checkpoint list remains unchanged

#### Scenario: Rollback failure shows error alert
- **GIVEN** the user confirms a rollback
- **WHEN** the rollback API call fails
- **THEN** an alert dialog displays a "Rollback failed" message with the error details

#### Scenario: Successful rollback with git warning shows notice
- **GIVEN** the user confirms a rollback on a checkpoint with a git hash
- **WHEN** the rollback succeeds but returns a git warning
- **THEN** an alert dialog displays "Rolled back successfully" with the warning note

#### Scenario: Collapsing the timeline hides checkpoint details
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** the user clicks the compact bar again
- **THEN** the detailed checkpoint list collapses
- **AND** only the compact bar with count and dots remains visible
