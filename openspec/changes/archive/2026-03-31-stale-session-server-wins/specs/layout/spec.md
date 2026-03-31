## MODIFIED Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. **The system SHALL fetch the latest state from the server on load and re-render with fresh data when it differs from the cached localStorage state, ensuring stale browser sessions display current state.**

#### Scenario: Stale project layout is replaced by fresh server state on load
- **GIVEN** a project window was previously opened with a specific tab layout
- **AND** the layout was changed on another device (or the server state was updated directly)
- **WHEN** the user opens a browser tab with stale localStorage referencing the old layout
- **THEN** the project window initially renders with the cached layout
- **AND** within a short time the project window re-renders with the server's current layout
- **AND** the final displayed state matches the server state

#### Scenario: User edits during fetch window are preserved
- **GIVEN** the app loads with stale localStorage and the server fetch is in flight
- **WHEN** the user adds or closes a pane before the server response arrives
- **THEN** the user's local changes are preserved
- **AND** the server response does not overwrite the user's changes

#### Scenario: Split layout persists after page reload
- **GIVEN** the user has split the panel grid and a resize divider is visible
- **WHEN** the user reloads the page
- **THEN** the split layout is restored with the same divider arrangement
- **AND** the panel groups reappear with their tabs

#### Scenario: Splitting works in project windows
- **GIVEN** a project window is open with at least one tab in its tab bar
- **WHEN** the user right-clicks a tab in the project window
- **THEN** a context menu appears with available actions

#### Scenario: Move pane between groups removes it from the source group
- **GIVEN** the panel grid has two groups with multiple tabs each
- **WHEN** a pane is moved from the source group to the target group
- **THEN** the pane is removed from the source group's tab bar
- **AND** the pane appears in the target group's tab bar
- **AND** the target group activates the moved pane

#### Scenario: Move last pane from group collapses that group
- **GIVEN** the panel grid has two groups where one group contains only a single tab
- **WHEN** the last pane is moved from that group to the other group
- **THEN** the now-empty group is removed from the layout
- **AND** the remaining group expands to fill the available space

#### Scenario: No duplicate tabs in initial state
- **GIVEN** the user opens the application
- **WHEN** the tab bar renders with open panels
- **THEN** no tab label appears more than once in the tab bar

#### Scenario: Layout state saved to server via API
- **GIVEN** the user has open panels in the application
- **WHEN** the panel state changes
- **THEN** the open panels list is saved to the server via the panels API endpoint
- **AND** the panel order is saved to the server via the panel-order API endpoint

#### Scenario: Layout state restored from persistence on load
- **GIVEN** panel state was previously saved to the server
- **WHEN** the user navigates to the application
- **THEN** the previously open panels are restored in the tab bar
- **AND** the main content area renders the restored panels
