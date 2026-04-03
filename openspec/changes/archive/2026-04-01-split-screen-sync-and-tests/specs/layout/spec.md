## MODIFIED Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. The system SHALL fetch the latest state from the server on load and re-render with fresh data when it differs from the cached localStorage state, ensuring stale browser sessions display current state. **This applies to both the top-level grid layout (PanelGrid) and project-internal layouts (ProjectWindow).**

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
