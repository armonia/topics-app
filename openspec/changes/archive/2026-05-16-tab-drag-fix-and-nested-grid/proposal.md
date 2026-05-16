## Why

Two UX issues degrade the split panel experience:
1. **Tab drag shows file icon**: Dragging a tab in the tab bar triggers file-like drag behavior (browser default ghost image), confusing users into thinking they're dropping a file.
2. **No column-specific splits**: "Split Down" always creates a full-width row at the bottom. Users need to split a tab below a specific column — e.g., having `[A|B]` and splitting B down to `[A|B] / [_|C]` where C sits only below B.

## What Changes

- Fix tab drag ghost image by adding `setDragImage()` with a custom tab preview element
- Refactor the grid data model from flat `PanelGridRow[]` to a recursive tree (`GridNode`) that supports nested row/column splits
- Update all grid manipulation (split, resize, drop, persistence, rendering) to use the recursive model
- Add E2E tests for tab drag behavior and column-specific split placement

## Capabilities

### New Capabilities

### Modified Capabilities
- `layout`: The grid layout system will support recursive nesting (columns within rows, rows within columns) for precise split placement, and tab drag will use proper drag images

## Impact

- `client/src/components/Layout/PaneTabBar.tsx` — add `setDragImage()` in drag start handler
- `client/src/types/index.ts` — replace `PanelGridRow` with recursive `GridNode` type
- `client/src/components/Layout/PanelGrid.tsx` — major refactor: sync effect, rendering, split/drop handlers, resize callbacks, persistence
- `client/src/hooks/useGridResize.ts` — update to navigate nested tree for resize
- `tests/e2e/` — new tests for tab drag and column-specific splits
- Server persistence format changes (backward-compatible migration)
