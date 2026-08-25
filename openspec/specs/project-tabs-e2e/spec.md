## ADDED Requirements

### Requirement: PROJECT-TABS-01 — Project Window Pane Management

The system SHALL support opening, switching, and closing pane tabs within a project window context.

#### Scenario: Project window displays its own tab bar
- **GIVEN** the user opens a project from the sidebar
- **WHEN** the project window loads
- **THEN** a tab bar is visible within the project window
- **AND** at least one default pane tab is shown

#### Scenario: Add pane via project window add-pane menu
- **GIVEN** a project window is open with its tab bar visible
- **WHEN** the user clicks the add pane (+) button in the project tab bar
- **THEN** a dropdown menu appears with available pane types (Files, Terminal, Browser, Git, etc.)
- **AND** selecting a pane type adds a new tab to the project window

#### Scenario: Switch between project pane tabs
- **GIVEN** a project window has multiple tabs open (e.g., Files and Terminal)
- **WHEN** the user clicks a different tab in the project tab bar
- **THEN** the content area switches to show the selected pane
- **AND** the clicked tab becomes the active tab

#### Scenario: Close a project pane tab
- **GIVEN** a project window has multiple tabs open
- **WHEN** the user clicks the close button on a tab
- **THEN** the tab is removed from the project tab bar
- **AND** the adjacent tab becomes active

### Requirement: PROJECT-TABS-02 — Project Tab State Persistence

The system SHALL persist project window tab layout and restore it when the project is reopened.

#### Scenario: Project pane tabs persist after reload
- **GIVEN** the user has opened specific pane tabs in a project window (e.g., Files, Terminal, Git)
- **WHEN** the user reloads the page
- **THEN** the project window restores with the same pane tabs
- **AND** the active tab is the one that was active before reload

#### Scenario: Project layout with splits persists after reload
- **GIVEN** the user has split the project window into multiple pane groups
- **WHEN** the user reloads the page
- **THEN** the split layout is restored with the same groups and tabs

### Requirement: PROJECT-TABS-03 — Project Tab Status Badges

The system SHALL display status badges on project tabs indicating git status and running processes.

#### Scenario: Project tab shows git modified file count
- **GIVEN** a project has modified files tracked by git
- **WHEN** the project tab is visible in the tab bar
- **THEN** the tab displays a badge or indicator showing the number of modified files

#### Scenario: Project tab shows running process count
- **GIVEN** a project has running processes (e.g., dev server)
- **WHEN** the project tab is visible in the tab bar
- **THEN** the tab displays a badge or indicator showing the number of running processes

### Requirement: PROJECT-TABS-MOBILE-01 — A project flattens to a single tab strip on a phone

The system SHALL render a project window's panes through `SplitTree` on desktop and
SHALL flatten them to exactly one visible tab strip below the mobile breakpoint,
carrying the same set of panes — no split cells, and no pane lost in the transition.

#### Scenario: The same panes survive the switch to a phone viewport
- **GIVEN** a project window is open with at least two panes in it (for example a chat and a browser)
- **THEN** the project window shows at least one split group cell on desktop
- **AND** the set of pane ids visible in the project is recorded
- **WHEN** the viewport is shrunk to a phone size (390×844)
- **THEN** no split group cell is rendered anywhere on the page
- **AND** exactly one visible tab bar remains in the whole page
- **AND** the set of pane ids in that single strip equals the set recorded on desktop
