## MODIFIED Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically with recursive nesting, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. Splits SHALL be column-specific: "Split Down" on a panel in a multi-column row creates a sub-split below that specific column only, not a full-width row. Tab dragging SHALL use proper drag images, not browser default file icons.

#### Scenario: Tab drag shows tab preview, not file icon
- **GIVEN** a tab is visible in the tab bar
- **WHEN** the user starts dragging the tab
- **THEN** the drag ghost image shows a styled tab preview
- **AND** the drag does NOT trigger file drop zones in the UI

#### Scenario: Split Down below a specific column
- **GIVEN** the grid has two panels side by side `[A | B]`
- **WHEN** the user right-clicks panel B and selects Split Down
- **THEN** panel B splits into a vertical stack with a new panel C below it
- **AND** panel A remains unchanged at full row height
- **AND** the layout becomes `[A | B/C]` where B and C are stacked within the right column

#### Scenario: Split Right within a specific row
- **GIVEN** the grid has two panels stacked vertically `[A] / [B]`
- **WHEN** the user right-clicks panel B and selects Split Right
- **THEN** panel B splits into a horizontal pair with a new panel C beside it
- **AND** panel A remains unchanged at full row width
- **AND** the layout becomes `[A] / [B | C]` where B and C are side by side within the bottom row

#### Scenario: Nested splits create multi-level layout
- **GIVEN** the grid starts with a single panel A
- **WHEN** the user splits A right to get `[A | B]`, then splits B down to get `[A | B/C]`
- **THEN** the grid has 3 panels: A full-height on left, B and C stacked on right
- **AND** both a column divider (A|B/C) and a row divider (B-C) are visible and draggable

#### Scenario: Recursive split layout persists across reload
- **GIVEN** a nested split layout exists (e.g., `[A | B/C]`)
- **WHEN** the user reloads the page
- **THEN** the nested split layout is restored exactly as it was

#### Scenario: Legacy flat grid format is auto-migrated
- **GIVEN** the user has a saved grid layout in the old flat format (`{gridRows: [...]}`)
- **WHEN** the app loads
- **THEN** the layout is automatically converted to the new nested tree format
- **AND** the visual layout remains identical
