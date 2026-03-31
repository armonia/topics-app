# Commands & Settings

**Purpose:** Specifies behavioral scenarios for the command palette, keyboard shortcuts, theme management, and application settings including persistence and graceful degradation.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The application is loaded with at least one topic visible
- No modal dialogs are open

## Requirements

### CMD-01: Command Palette, Keyboard Shortcuts, Theme & Settings

The system SHALL provide a command palette accessible via keyboard shortcut for topic search, file search, message search, and action execution; a keyboard shortcuts help modal; theme switching with persistence; and a settings panel with font size, message density, and push notification controls.

#### Scenario: Open command palette with keyboard shortcut
- GIVEN the application is loaded with no modals open
- WHEN the user presses Cmd+K
- THEN the command palette opens as a dialog overlay
- AND the search input is focused and ready for typing

#### Scenario: Command palette has proper dialog semantics
- GIVEN the command palette is open
- WHEN the user inspects the overlay
- THEN the overlay has a dialog role for accessibility
- AND the search input is the focused element

#### Scenario: Close command palette with Escape key
- GIVEN the command palette is open
- WHEN the user presses the Escape key
- THEN the command palette closes
- AND the palette is removed from the visible DOM

#### Scenario: Arrow keys navigate between palette options
- GIVEN the command palette is open with multiple options listed
- WHEN the user presses ArrowDown
- THEN the next option becomes selected with aria-selected true
- AND the previously selected option loses selection

#### Scenario: Arrow up returns to previous palette option
- GIVEN the second palette option is selected
- WHEN the user presses ArrowUp
- THEN the first option becomes selected again
- AND the second option loses selection

#### Scenario: First palette option is selected by default
- GIVEN the command palette just opened
- WHEN the user views the options list
- THEN the first option is marked as selected

#### Scenario: Topic search filters results as user types
- GIVEN the command palette is open with topics available
- WHEN the user types a partial topic name in the search input
- THEN only topics matching the search text are shown
- AND non-matching topics are hidden from the results

#### Scenario: Selecting a topic from palette navigates to it
- GIVEN the command palette shows filtered topic results
- WHEN the user clicks on a matching topic option
- THEN the palette closes
- AND the selected topic's content appears in the main area

#### Scenario: Theme toggle command changes document theme
- GIVEN the command palette is open showing available actions
- WHEN the user selects the theme toggle action
- THEN the palette closes
- AND the document theme class changes to reflect the new mode

#### Scenario: Theme cycles through light, dark, and system modes
- GIVEN the current theme is set to light mode
- WHEN the user executes the theme toggle action
- THEN the theme advances to dark mode
- AND the toggle action label updates to reflect the next available mode

#### Scenario: New chat command creates a new topic
- GIVEN the command palette is open
- WHEN the user selects the New Chat action
- THEN the palette closes
- AND a new empty chat pane opens with a start conversation prompt

#### Scenario: File search shows matching files from project
- GIVEN the command palette is open and a project with files is associated
- WHEN the user types a filename query
- THEN matching files appear in a FILES category section
- AND the results are displayed in the same listbox structure as other options

> Note: File search requires a focused topic with a projectPath set; test coverage uses route mocking for the file list API.

#### Scenario: File search works when project pane is focused
- GIVEN a project pane is focused and the palette is open
- WHEN the user types a file search query
- THEN the palette fetches the file list from the project files API
- AND matching files appear in the results

#### Scenario: Message search shows debounced results
- GIVEN the command palette is open
- WHEN the user types a search query of at least two characters
- THEN the palette waits for the debounce period before querying
- AND message results appear under a MESSAGES category header

#### Scenario: Message search results display role and content
- GIVEN message search results are returned from the search API
- WHEN the results are displayed in the palette
- THEN each result shows the message role prefix
- AND the message content snippet is visible

#### Scenario: Message search queries the search API endpoint
- GIVEN the user has typed a search query in the palette
- WHEN the debounce period elapses
- THEN a request is sent to the search API endpoint
- AND the response results are rendered in the palette

#### Scenario: Selecting a message result closes the palette
- GIVEN message search results are visible in the palette
- WHEN the user clicks on a message result
- THEN the palette closes
- AND the user is navigated to the relevant topic

#### Scenario: Open keyboard shortcuts modal
- GIVEN the application is loaded
- WHEN the user presses Cmd+/
- THEN the keyboard shortcuts modal opens
- AND a heading titled Keyboard Shortcuts is visible

#### Scenario: Keyboard shortcuts modal shows all shortcut groups
- GIVEN the keyboard shortcuts modal is open
- WHEN the user views the modal contents
- THEN group headings for General, Chat, and Voice are displayed
- AND at least one shortcut description appears under each group

#### Scenario: Keyboard shortcuts modal shows desktop-only shortcuts
- GIVEN the application is running in an Electron desktop context
- WHEN the user opens the keyboard shortcuts modal
- THEN desktop-specific shortcuts such as New Chat and Close Panel are visible

#### Scenario: Close keyboard shortcuts modal with toggle shortcut
- GIVEN the keyboard shortcuts modal is open
- WHEN the user presses Cmd+/ again
- THEN the modal closes
- AND the keyboard shortcuts heading is no longer visible

#### Scenario: Settings panel opens from sidebar menu
- GIVEN the sidebar is visible
- WHEN the user opens the settings from the sidebar menu
- THEN a settings panel appears as a modal overlay
- AND theme selection buttons for Light, Dark, and System are visible
- AND a font size control is visible
- AND message density options for Compact and Comfortable are visible

#### Scenario: Close settings panel via backdrop
- GIVEN the settings panel is open
- WHEN the user clicks outside the settings panel on the backdrop
- THEN the settings panel closes
- AND the main application is visible again

#### Scenario: Theme selection in settings persists across page reload
- GIVEN the settings panel is open
- WHEN the user selects the Dark theme button
- THEN the document theme class changes to dark
- AND after reloading the page the dark theme remains applied

#### Scenario: All settings values persist across page reload
- GIVEN the user has changed message density to Compact and font size to 16
- WHEN the user reloads the page and reopens settings
- THEN the Compact button appears with active styling
- AND the font size control shows 16

#### Scenario: Push notification toggle handles unsupported browser
- GIVEN the browser does not support push notifications
- WHEN the user opens the settings panel
- THEN the push notification section is either absent or shows a graceful fallback
- AND all other settings controls render correctly

#### Scenario: Push notification toggle shows denied state
- GIVEN the browser has denied notification permission
- WHEN the user opens the settings panel
- THEN the push notification area displays a blocked-by-browser message
- AND the user cannot enable push notifications

> Note: Push notification states depend on browser API support; Playwright Chromium may show different states.

#### Scenario: Palette search is debounced to avoid excessive queries
- GIVEN the command palette is open
- WHEN the user types rapidly in the search input
- THEN search API requests are not sent on every keystroke
- AND results appear only after the debounce period elapses

#### Scenario: Selecting a file from palette opens it in editor
- GIVEN file search results are visible in the command palette
- WHEN the user selects a file result
- THEN the palette closes
- AND the selected file opens in the file editor pane

> Note: File selection navigation depends on project pane routing; test coverage verifies the palette close mechanism.

#### Scenario: Category headers organize palette results by type
- GIVEN the command palette has results from multiple categories
- WHEN the user views the results list
- THEN category headers such as ACTIONS, TOPICS, FILES, and MESSAGES group the results
- AND each result appears under its appropriate category
