## MODIFIED Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. The system SHALL fetch the latest state from the server on load and re-render with fresh data when it differs from the cached localStorage state, ensuring stale browser sessions display current state. This applies to both the top-level grid layout (PanelGrid) and project-internal layouts (ProjectWindow). All layout behaviors SHALL function identically when the app runs inside a production Electron window (loaded from `localhost:3333`) as when accessed via a web browser.

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

#### Scenario: Layout persists across production Electron reload
- **GIVEN** the user has a multi-panel layout in production Electron
- **WHEN** client assets rebuild and Electron triggers an auto-reload
- **THEN** the layout is restored from the server after reload
- **AND** the panel arrangement matches the pre-reload state

#### Scenario: Detached topic window layout works in production
- **GIVEN** the user is running Topics in production Electron
- **WHEN** the user detaches a topic to a separate window
- **THEN** the detached window opens with the correct topic loaded
- **AND** the main window layout is unaffected
- **AND** the detached window can be focused, closed, and re-detached

#### Scenario: Browser tabs panel works in production Electron
- **GIVEN** the user is running Topics in production Electron
- **WHEN** the user opens the browser tabs panel
- **THEN** BrowserViews are created and positioned correctly
- **AND** tab switching, navigation, and close work as expected
