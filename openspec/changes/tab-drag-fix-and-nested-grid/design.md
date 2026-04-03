## Context

The grid currently uses a flat `PanelGridRow[]` model — each row has `itemKeys[]` and `widths[]`. This can't represent nested splits like "panel C below column B only". The rendering loop is a simple 2-level `rows.map → items.map`. Tab drag doesn't set a custom drag image, causing file-like browser behavior.

## Goals / Non-Goals

**Goals:**
- Fix tab drag ghost image (quick)
- Recursive grid model supporting arbitrary nesting: split down below a specific column, or split right within a specific row
- Preserve existing split/resize/drop functionality
- Backward-compatible migration from flat to nested format
- E2E test coverage for new capabilities

**Non-Goals:**
- Infinite nesting depth (cap at 3 levels to prevent complexity)
- Real-time cross-tab grid sync (already handled by ui-state WebSocket)
- Changing the existing ProjectWindow internal split system (GroupLayout already handles nested layouts correctly)

## Decisions

**1. Recursive GridNode model**

Replace `PanelGridRow` with a recursive tree:
```typescript
interface GridNode {
  type: 'row' | 'col' | 'leaf';
  // 'row' children are laid out vertically (stacked), each child is a column or leaf
  // 'col' children are laid out horizontally (side by side), each child is a row or leaf
  // 'leaf' is a terminal node containing a grid item
  children?: GridNode[];
  sizes?: number[];       // proportional sizes for children (sum to 1)
  itemKey?: string;       // only for type='leaf'
}
```

Example: `[A|B] / [_|C]` (C below B only):
```json
{
  "type": "row",
  "children": [
    { "type": "leaf", "itemKey": "standalone" },
    { "type": "col", "children": [
      { "type": "leaf", "itemKey": "solo:b" },
      { "type": "leaf", "itemKey": "solo:c" }
    ], "sizes": [0.5, 0.5] }
  ],
  "sizes": [0.5, 0.5]
}
```

**2. Migration: flat → nested**

On load, detect if stored data is in the old flat format (`{gridRows: [...]}`) and convert to the new tree format. The new format stores `{gridTree: {...}, soloTopicIds: [...]}`.

**3. Tab drag fix: custom ghost element**

In `PaneTabBar.handleTabDragStart`, create a lightweight clone element, style it as a tab preview, and pass to `e.dataTransfer.setDragImage()`. Remove after dragend.

**4. Split placement: context-aware**

When the user selects "Split Down" on a tab, the split handler identifies which GridNode leaf the tab belongs to, then wraps that leaf in a `col` node with two children (original + new). Similarly for "Split Right" → wraps in `row` node.

**5. Rendering: recursive component**

Replace the 2-level `map` rendering with a recursive `<GridNodeView>` component that renders `row`/`col`/`leaf` nodes. Row dividers between children of a `col`, column dividers between children of a `row`.

## Risks / Trade-offs

- **Complexity increase**: Recursive model is harder to debug than flat array. Mitigated by keeping max depth at 3.
- **Resize refactor**: `useGridResize` needs to resolve dividers by tree path. More complex but the resolver pattern already abstracts this.
- **Persistence migration**: Old format must be auto-detected and converted. One-way migration (new format can't go back to old).
