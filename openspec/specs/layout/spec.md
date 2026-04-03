## Purpose

Specifies behavioral scenarios for the application layout system including panel grid splitting, resizing, persistence, sidebar navigation, pane tab management, add-pane menu, and mobile responsiveness.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The main application layout is visible with a sidebar on the left and a content area on the right
- At least one topic exists and is open as a chat pane in the tab bar

## Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. The system SHALL fetch the latest state from the server on load and re-render with fresh data when it differs from the cached localStorage state, ensuring stale browser sessions display current state. This applies to both the top-level grid layout (PanelGrid) and project-internal layouts (ProjectWindow).

#### Scenario: Top-level grid split layout restored from server on fresh session
- **GIVEN** the user had a split grid layout (e.g., two panels side by side)
- **AND** the layout was saved to the server
- **WHEN** the user opens the app from a different browser session with no localStorage
- **THEN** the server's grid layout is fetched and applied
- **AND** the split layout is displayed correctly

#### Scenario: Split Right creates correct horizontal multi-column layout
- **GIVEN** a chat pane is open in the tab bar
- **WHEN** the user right-clicks the tab and selects Split Right
- **THEN** a vertical col-resize divider appears between the two panels
- **AND** both panels have their own independent tab bars
- **AND** the divider can be dragged to resize

#### Scenario: Split Down creates correct vertical multi-row layout
- **GIVEN** a chat pane is open in the tab bar
- **WHEN** the user right-clicks the tab and selects Split Down
- **THEN** a horizontal row-resize divider appears between the two panels
- **AND** both panels are stacked vertically
- **AND** the divider can be dragged to resize

#### Scenario: Project-internal split layout restored from server
- **GIVEN** a project window had a split layout (e.g., Files + Terminal side by side)
- **AND** the layout was saved to the server
- **WHEN** the user reloads the page
- **THEN** the project window restores with the same split layout and pane arrangement

#### Scenario: Mixed project and chat panels in multi-column split
- **GIVEN** a project panel and a chat panel are both open
- **WHEN** they are displayed in a multi-column layout (side by side)
- **THEN** both panels render with their own independent tab bars
- **AND** a col-resize divider separates them

#### Scenario: Project window nested multi-row multi-column splits
- **GIVEN** a project window is open with multiple panes
- **WHEN** the user performs Split Right and Split Down within the project window
- **THEN** the project window displays 3+ panes in a grid layout
- **AND** both row-resize and col-resize dividers are functional

#### Scenario: Mixed layout persists across reload
- **GIVEN** the user has a project panel and a chat panel in a multi-column split
- **AND** the layout was saved to the server
- **WHEN** the user reloads the page
- **THEN** both the project and chat panels are restored in the same multi-column layout

#### Scenario: Multi-row multi-column top-level grid
- **GIVEN** the user has performed Split Down (creating 2 rows) and Split Right within one row
- **WHEN** the grid renders
- **THEN** both row-resize and col-resize dividers are visible
- **AND** each cell has its own independent tab bar

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

#### Scenario: Split Right via tab context menu creates side-by-side panels
- **GIVEN** at least two chat panes are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Split Right from the context menu
- **THEN** a vertical column-resize divider appears between two panel groups
- **AND** both panel groups display their own tab bars

#### Scenario: Split Down via tab context menu creates above/below panels
- **GIVEN** at least two chat panes are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Split Down from the context menu
- **THEN** a horizontal row-resize divider appears between two panel groups
- **AND** the panels are arranged vertically with one above the other

#### Scenario: Resize split panels by dragging col-resize divider
- **GIVEN** the panel grid has been split horizontally with a column-resize divider visible
- **WHEN** the user drags the column-resize divider to the right
- **THEN** the left panel group becomes wider and the right panel group becomes narrower
- **AND** the divider position updates to follow the drag

#### Scenario: Resize split panels by dragging row-resize divider
- **GIVEN** the panel grid has been split vertically with a row-resize divider visible
- **WHEN** the user drags the row-resize divider downward
- **THEN** the top panel group becomes taller and the bottom panel group becomes shorter
- **AND** the divider position updates to follow the drag

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

#### Scenario: Main area has sufficient dimensions
- **GIVEN** the application is loaded in a standard desktop viewport
- **WHEN** the main content area renders
- **THEN** the main area width is greater than 400 pixels
- **AND** the main area height is greater than 300 pixels

#### Scenario: Tab bar height remains compact
- **GIVEN** a panel group is visible with a tab bar
- **WHEN** the tab bar renders
- **THEN** the tab bar height is less than 60 pixels

#### Scenario: Grid rows and columns respect maximum limits
- **GIVEN** the panel grid has existing splits
- **WHEN** the user attempts to split beyond the maximum allowed columns or rows
- **THEN** the grid does not exceed 4 columns or 4 rows

> Note: Maximum grid limits are enforced in source code but have limited direct E2E test coverage for the boundary case.

#### Scenario: Drag no-op when dropping tab on same position
- **GIVEN** a tab is being dragged within the same tab bar
- **WHEN** the user drops the tab at the same position it started from
- **THEN** no layout change occurs
- **AND** the tab order remains unchanged

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

#### Scenario: StandaloneChatGroup renders with tab bar and chat content
- **GIVEN** the user opens a topic from the sidebar
- **WHEN** the chat pane loads
- **THEN** a tab bar is visible above the chat content
- **AND** the message input textbox is visible below the message list

#### Scenario: Closing all panels produces a clean empty state
- **GIVEN** multiple panels are open
- **WHEN** all panels are closed
- **THEN** no tabs remain in the tab bar
- **AND** reloading the page does not restore any stale panels

#### Scenario: Closing a split panel removes it without ghost panels
- **GIVEN** the panel grid has been split with a solo panel visible
- **WHEN** the user closes the tab in the solo panel
- **THEN** the solo panel group is removed from the layout
- **AND** the number of panel tab bars decreases

### Requirement: LAYOUT-02 — Sidebar, Pane Tabs, Add-Pane Menu & Mobile

The system SHALL support sidebar toggle, pane tab bar interactions including close and context menu, add-pane menu for inserting new pane types, project window sub-panels, tab drag reorder, connection status display, and mobile responsive layout.

#### Scenario: Sidebar toggle via keyboard shortcut
- **GIVEN** the sidebar is currently visible
- **WHEN** the user presses the keyboard shortcut to toggle the sidebar
- **THEN** the sidebar becomes hidden
- **AND** pressing the shortcut again makes the sidebar visible

#### Scenario: Sidebar toggle via toggle button
- **GIVEN** the sidebar toggle button is visible in the interface
- **WHEN** the user clicks the sidebar toggle button
- **THEN** the sidebar visibility toggles between visible and hidden

#### Scenario: Pane tab bar shows close button on each tab
- **GIVEN** a panel group has tabs in its tab bar
- **WHEN** the user views the tab bar
- **THEN** each tab displays a close button

#### Scenario: Right-click tab opens context menu with Close and Split options
- **GIVEN** a chat pane tab is visible in the tab bar
- **WHEN** the user right-clicks the tab
- **THEN** a context menu appears
- **AND** the menu includes a Close option
- **AND** the menu includes a Split Right option
- **AND** the menu includes a Split Down option

#### Scenario: Close tab via context menu
- **GIVEN** a tab's context menu is open
- **WHEN** the user clicks the Close option
- **THEN** the tab is removed from the tab bar
- **AND** the context menu is dismissed

#### Scenario: Add pane button opens dropdown menu
- **GIVEN** a panel group has a tab bar with an add pane button
- **WHEN** the user clicks the add pane button
- **THEN** a dropdown menu appears with pane type options

#### Scenario: Add pane menu lists available pane types
- **GIVEN** the add pane dropdown menu is open
- **WHEN** the user views the menu options
- **THEN** the menu includes options such as Files, Terminal, Git, Browser, Board, and Agents

#### Scenario: Select pane type from add pane menu adds new tab
- **GIVEN** the add pane dropdown menu is open
- **WHEN** the user selects a pane type from the menu
- **THEN** a new tab of that type is added to the tab bar

#### Scenario: ProjectWindow opens with sub-panels and tab bar
- **GIVEN** a project exists in the sidebar
- **WHEN** the user clicks the project entry in the sidebar
- **THEN** a project window opens with at least one tab in its tab bar

#### Scenario: ProjectWindow add-pane menu shows utility pane types
- **GIVEN** a project window is open
- **WHEN** the user clicks the add pane button in the project window
- **THEN** the dropdown menu shows utility types including Terminal, Git, and Browser

#### Scenario: Tab drag reorder within tab bar
- **GIVEN** multiple tabs are visible in a single tab bar
- **WHEN** the user drags a tab to a different position within the same tab bar
- **THEN** the tab order is rearranged to reflect the new position

> Note: Tab drag reorder uses HTML5 draggable attribute. E2E tests verify tabs are draggable but full reorder assertion is limited due to pointer event interaction complexity.

#### Scenario: Connection status indicator shows connected state
- **GIVEN** the application is loaded and the WebSocket connection is established
- **WHEN** the user views the connection status indicator
- **THEN** the indicator displays a connected status
- **AND** the indicator has an accessible label indicating the connection state

#### Scenario: Mobile viewport renders content at 375px width
- **GIVEN** the viewport is set to 375 pixels wide
- **WHEN** the application loads
- **THEN** meaningful content is rendered on the page
- **AND** the layout adapts to the narrow viewport

#### Scenario: Mobile sidebar may start hidden
- **GIVEN** the viewport is at mobile width
- **WHEN** the application loads
- **THEN** the sidebar may be initially hidden to maximize content area
- **AND** the main content or a navigation element is visible

#### Scenario: Project window internal pane layout persists across reload
- **GIVEN** a project window is open with a custom pane arrangement
- **WHEN** the user adds a non-chat pane and the layout is saved to the server
- **AND** the user reloads the page and reopens the project
- **THEN** the project window restores the previously saved pane arrangement
- **AND** the server layout data matches what was saved before the reload

#### Scenario: Cross-device panel sync updates without stale overwrites
- **GIVEN** the application is connected via WebSocket
- **WHEN** another device updates the panel state via the server API
- **THEN** the local panel list is updated to include the new panels
- **AND** the per-device focused panel is not overwritten by the sync

> Note: Cross-device sync is also relevant to the broader real-time collaboration system.

#### Scenario: Close Others removes all other tabs at once
- **GIVEN** three or more tabs are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Close Others from the context menu
- **THEN** all other tabs are removed
- **AND** only the right-clicked tab remains

#### Scenario: Clicking tabs updates focus correctly
- **GIVEN** multiple tabs are visible in the tab bar
- **WHEN** the user clicks on different tabs in sequence
- **THEN** each clicked tab becomes the active tab
- **AND** the content area updates to show the selected pane
- **AND** the total tab count remains stable
