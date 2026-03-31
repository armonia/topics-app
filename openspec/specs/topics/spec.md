# Topic Management

**Purpose:** Specifies behavioral scenarios for topic lifecycle management and organizational features including creation, hierarchy, search, and collaboration indicators.

## Background

Common preconditions shared across scenarios:

- The user is logged into Topics App at http://localhost:3333
- The sidebar is visible with the topic tree
- At least one topic exists in the sidebar

## Requirements

### TOPIC-01: CRUD & Lifecycle

The system SHALL support creating, renaming, archiving, deleting, and restoring topics with full lifecycle management including settings, hierarchy, and templates.

#### Scenario: Create topic via new topic button
- GIVEN the sidebar is visible with the topic tree
- WHEN the user clicks the new topic button in the sidebar header
- THEN a new topic dialog appears with a name input field and template options

#### Scenario: Create topic via keyboard shortcut
- GIVEN the application is open
- WHEN the user presses Cmd+Shift+N
- THEN a new topic dialog appears with a name input field

#### Scenario: Create topic with custom name
- GIVEN the new topic dialog is open
- WHEN the user enters a topic name and clicks Create Topic
- THEN the dialog closes
- AND the new topic appears in the sidebar

#### Scenario: Create topic from template
- GIVEN the new topic dialog is open
- WHEN the user selects the "Code Review" template
- THEN the name input is pre-filled with "Code Review"
- AND clicking Create Topic creates a topic with that name

#### Scenario: Rename topic via context menu
- GIVEN a topic exists in the sidebar
- WHEN the user right-clicks the topic and selects Rename
- THEN an input field appears with the current name
- AND entering a new name and clicking Save updates the topic name in the sidebar

#### Scenario: Rename updates displayed name immediately
- GIVEN a topic has been renamed via the context menu
- WHEN the save action completes
- THEN the old name is no longer visible in the sidebar
- AND the new name appears in its place

#### Scenario: Delete topic with confirmation
- GIVEN a topic exists in the sidebar
- WHEN the user right-clicks the topic and selects Archive / Delete
- THEN a confirmation prompt appears showing the topic name
- AND clicking Delete removes the topic from the sidebar

#### Scenario: Cancel delete preserves topic
- GIVEN the delete confirmation prompt is showing for a topic
- WHEN the user clicks Cancel
- THEN the confirmation prompt closes
- AND the topic remains visible in the sidebar

#### Scenario: Archive topic removes from active list
- GIVEN a topic exists in the sidebar
- WHEN the user archives the topic via the context menu
- THEN the topic disappears from the active topics list

#### Scenario: Restore archived topic
- GIVEN a topic has been archived
- WHEN the user restores the topic from the archive view
- THEN the topic reappears in the active topics list in the sidebar

#### Scenario: Switch between topics updates main panel
- GIVEN two topics exist with different names
- WHEN the user clicks a different topic in the sidebar
- THEN the main panel updates to show the selected topic's content

#### Scenario: Topic settings modal opens from context menu
- GIVEN a topic is open as the active panel
- WHEN the user opens the context menu on the topic tab and selects Settings
- THEN a settings dialog appears with system prompt and context file options

#### Scenario: System prompt save persists across sessions
- GIVEN the topic settings dialog is open
- WHEN the user enters a system prompt and clicks Save
- THEN the prompt is saved
- AND reopening the settings dialog shows the saved system prompt

#### Scenario: Context files add and persist
- GIVEN the topic settings dialog is open
- WHEN the user adds a context file path and presses Enter
- THEN the file appears in the context files list
- AND the file remains in the list after saving and reopening settings

#### Scenario: Topic hierarchy with nesting
- GIVEN multiple topics exist in the sidebar
- WHEN the user drags a topic onto another topic
- THEN the dragged topic becomes a child nested under the target topic

#### Scenario: Newly created topic becomes active
- GIVEN the user has just created a new topic via the dialog
- WHEN the topic creation completes
- THEN the new topic is automatically selected in the sidebar
- AND the main panel displays the new topic's empty chat

#### Scenario: Delete last topic shows empty state
- GIVEN only one topic remains in the sidebar
- WHEN the user deletes that topic
- THEN the sidebar shows an empty state or prompt to create a new topic

#### Scenario: Duplicate topic names are allowed
- GIVEN a topic named "My Topic" exists in the sidebar
- WHEN the user creates another topic also named "My Topic"
- THEN both topics appear in the sidebar with the same name

### TOPIC-02: Organization

The system SHALL provide organizational features for topics including drag-and-drop reordering, search and filtering, unread indicators, color customization, and project folder grouping.

#### Scenario: Search filters topics by name
- GIVEN multiple topics exist in the sidebar
- WHEN the user types a search term in the topic search field
- THEN only topics whose names match the search term are displayed

#### Scenario: Search is case-insensitive
- GIVEN a topic named "My Project" exists in the sidebar
- WHEN the user types "my project" in lowercase in the search field
- THEN the "My Project" topic is displayed in the filtered results

#### Scenario: Clear search restores all topics
- GIVEN the search field contains a filter term with some topics hidden
- WHEN the user clears the search field
- THEN all topics are displayed again in the sidebar

#### Scenario: Search with no matches shows empty state
- GIVEN topics exist in the sidebar
- WHEN the user types a search term that matches no topic names
- THEN a no-results indicator is shown in the sidebar

#### Scenario: Drag-reorder changes topic position
- GIVEN multiple topics are visible in the sidebar
- WHEN the user drags a topic above or below another topic
- THEN the topic list updates to reflect the new position

#### Scenario: Drag-reorder persists after reload
- GIVEN the user has reordered topics via drag-and-drop
- WHEN the user reloads the page
- THEN the topics appear in the reordered position

#### Scenario: Unread badge appears on new message
- GIVEN a topic is not currently selected
- WHEN a new message arrives for that topic via the server
- THEN an unread badge with the message count appears on the topic

#### Scenario: Unread badge clears when topic is focused
- GIVEN a topic has an unread badge showing a message count
- WHEN the user clicks on that topic to select it
- THEN the unread badge disappears

#### Scenario: Color customization via context menu
- GIVEN a topic exists in the sidebar
- WHEN the user right-clicks the topic and selects Change color
- THEN a color picker submenu appears
- AND selecting a color applies a visual color indicator to the topic

#### Scenario: Color persists after reload
- GIVEN a topic has been assigned a custom color
- WHEN the user reloads the page
- THEN the topic retains its color indicator

#### Scenario: Project folder expand and collapse
- GIVEN a project folder section exists in the sidebar
- WHEN the user clicks the project folder header to collapse it
- THEN the folder's contents are hidden
- AND clicking the header again expands the folder to show its contents

#### Scenario: Sidebar sections toggle visibility
- GIVEN the sidebar contains multiple collapsible sections
- WHEN the user clicks a section header to collapse it
- THEN that section's items are hidden
- AND the section can be expanded again by clicking the header

#### Scenario: Topic with messages retains history on switch
- GIVEN a topic contains previous messages
- WHEN the user switches to another topic and then switches back
- THEN the original topic's message history is still visible

#### Scenario: Drag to nest topic under parent
- GIVEN two topics exist at the same level in the sidebar
- WHEN the user drags one topic directly onto another topic
- THEN the dragged topic becomes a nested child of the target topic
