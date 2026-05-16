## ADDED Requirements

### Requirement: Grid drop zones render visible overlay during drag
When a pane tab is being dragged over the `PanelGrid`, an overlay SHALL be rendered for ALL zone types: `left`, `right`, `top`, `bottom` (which create new grid splits), in addition to the already-existing `center` feedback (reorder). The overlay style SHALL be visually consistent with the existing `edgeSplitZone` overlay in `PaneTabBar` (dashed `primary` border, `primary/15` background, 4px border-radius).

#### Scenario: Left/right grid-zone overlay appears
- **WHEN** a tab is dragged into the left or right edge zone of a grid cell
- **THEN** an overlay SHALL render covering the left or right half of that cell
- **AND** the overlay SHALL use dashed `primary` border and `primary/15` bg

#### Scenario: Top/bottom grid-zone overlay appears
- **WHEN** a tab is dragged into the top or bottom edge zone of a grid cell
- **THEN** an overlay SHALL render covering the top or bottom half of that cell with consistent styling

#### Scenario: Center zone keeps existing inset shadow
- **WHEN** a tab is dragged into the center zone of a grid cell (reorder within group)
- **THEN** the existing `boxShadow` inset indicator (4px) SHALL continue to work unchanged

#### Scenario: Overlay disappears on drop or drag end
- **WHEN** the tab is dropped OR the drag is cancelled
- **THEN** the overlay SHALL be removed from the DOM

#### Scenario: Drop handler re-verifies position at drop time
- **WHEN** the drop handler fires
- **THEN** it SHALL re-read the actual mouse position from the drop event (not solely rely on the last dragover state) to guard against ref/state lag

### Requirement: Dragged tab maintains visual identity
The tab being dragged SHALL have a persistent visual state (reduced opacity on source + custom drag image via `setDragImage`) so the user always knows which tab is being moved.

#### Scenario: Source tab is faded during drag
- **WHEN** a tab drag starts
- **THEN** the source tab element SHALL have opacity <= 0.4 until drag ends

#### Scenario: Active tab highlight persists on non-dragged tab
- **WHEN** dragging tab A in a group where tab B is active
- **THEN** tab B SHALL retain its active highlight (ring) for the duration of the drag

### Requirement: Dropped tab becomes active
After a successful drop (reorder within group OR move across groups), the pane that was dragged SHALL become the active pane in its destination group.

#### Scenario: Reorder activates moved tab
- **GIVEN** a group with tabs [A, B, C] where A is active
- **WHEN** tab C is dragged to position 0
- **THEN** the group order SHALL become [C, A, B]
- **AND** tab C SHALL be the active pane

#### Scenario: Cross-group drop activates in destination
- **GIVEN** group G1 with tab A active, group G2 with tab B active
- **WHEN** tab A is dragged from G1 to G2
- **THEN** G2 SHALL contain A and B
- **AND** A SHALL be the active pane in G2
