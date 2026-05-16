## ADDED Requirements

### Requirement: Mark all as read on project folder
The sidebar SHALL provide a "Mark all as read" action on project folder context menus that clears unread counts for all child topics in that project.

#### Scenario: Mark all as read via project context menu
- **WHEN** the user right-clicks a project folder that has child topics with unreads
- **THEN** the context menu includes a "Mark all as read" option
- **AND** clicking it calls the mark-read API for each child topic with unreads
- **AND** the project folder's aggregated unread badge disappears
- **AND** individual child topic unread badges also disappear

#### Scenario: Mark all as read not shown when no unreads
- **WHEN** the user right-clicks a project folder with no unread child topics
- **THEN** the context menu does NOT include "Mark all as read"

### Requirement: Unread badges visible on child topics in expanded project
Individual topics within an expanded project folder SHALL display their own unread badges, not only contribute to the aggregated project-level count.

#### Scenario: Child topic shows unread badge when project expanded
- **GIVEN** a project folder is expanded in the sidebar
- **AND** a child topic has unread messages
- **WHEN** the user views the sidebar
- **THEN** the child topic row shows its own unread count badge
- **AND** the project folder row also shows the aggregated count

## MODIFIED Requirements

### Requirement: TOPIC-02 — Organization

The system SHALL provide organizational features for topics including drag-and-drop reordering, search and filtering, unread indicators, color customization, and project folder grouping. Unread badges SHALL be clearable both by focusing individual topics and by bulk-clearing via project folder context menus.

#### Scenario: Unread badge appears on new message
- **GIVEN** a topic is not currently selected
- **WHEN** a new message arrives for that topic via the server
- **THEN** an unread badge with the message count appears on the topic

#### Scenario: Unread badge clears when topic is focused
- **GIVEN** a topic has an unread badge showing a message count
- **WHEN** the user clicks on that topic to select it
- **THEN** the unread badge disappears

#### Scenario: Unread badge clears when topic chat is focused in project view
- **GIVEN** a topic has unreads and is open as a chat pane inside a ProjectWindow
- **WHEN** the user focuses that chat pane within the project
- **THEN** the unread badge disappears for that topic
- **AND** the project folder's aggregated count decreases accordingly

#### Scenario: Color customization via context menu
- **GIVEN** a topic exists in the sidebar
- **WHEN** the user right-clicks the topic
- **THEN** a context menu includes color customization options

#### Scenario: Search filters topics by name
- **GIVEN** topics exist in the sidebar
- **WHEN** the user types in the search field
- **THEN** only matching topics are shown
