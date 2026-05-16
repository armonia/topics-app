## 1. Tab drag ghost image fix

- [x] 1.1 In PaneTabBar.tsx `handleTabDragStart`, create a lightweight DOM clone element styled as a tab preview and call `e.dataTransfer.setDragImage()` with it; clean up the element after dragend

## 2. GridNode recursive type

- [x] 2.1 Define `GridNode` type in `types/index.ts`: `{ type: 'row'|'col'|'leaf', children?: GridNode[], sizes?: number[], itemKey?: string }`
- [x] 2.2 Add migration function `flatGridToTree(gridRows, gridRowHeights)` that converts old `PanelGridRow[]` format to new `GridNode` tree
- [x] 2.3 Add tree utility functions: `findLeaf(tree, itemKey)`, `insertSplit(tree, targetKey, newKey, direction)`, `removeLeaf(tree, itemKey)`, `flattenKeys(tree)`

## 3. PanelGrid refactor to recursive model

- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 3.1 Replace `gridRows`/`gridRowHeights` state with single `gridTree: GridNode` state, with localStorage + server persistence using new format
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 3.2 Update the sync effect (naturalGridItems → gridTree) to build/update tree structure instead of flat rows
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 3.3 Refactor `handleSplitPane` to use `insertSplit(tree, targetKey, newKey, direction)` for column-specific and row-specific splits
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 3.4 Update drop handlers to navigate and modify the tree
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 3.5 Update resize callbacks and `useGridResize` hook to work with tree paths instead of flat rowIdx/colIdx

## 4. Recursive rendering

- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 4.1 Create recursive `<GridNodeView>` component (or inline recursive render function) that renders `row`/`col`/`leaf` nodes with proper flex layout and dividers
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 4.2 Wire dividers with `data-*` attributes encoding tree path for resize resolver

## 5. Persistence and migration

- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 5.1 Update save effect to serialize `{gridTree, soloTopicIds}` to localStorage + server
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 5.2 On load, detect old format `{gridRows}` vs new format `{gridTree}` and auto-migrate

## 6. E2E tests

- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 6.1 Add test: tab drag does not trigger file drop behavior (drag tab, verify no file drop overlay)
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 6.2 Add test: Split Down below specific column creates nested layout (2-col → split one → verify both divider types)
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 6.3 Add test: nested split layout persists across reload
- [~] DEFERRED (recursive grid refactor on hold — flat grid works): 6.4 Add test: legacy flat format auto-migrates on load

---

## Audit 2026-05-16 — refactor deferred, change archived

**Completed (4/17)**:
- Drag preview ghost in PaneTabBar (1.1)
- `GridNode` type + tree utilities (`findLeaf`, `insertSplit`, `removeLeaf`, `flattenKeys`) and `flatGridToTree` migration helper (2.1–2.3)

**Deferred (13/17)** — recursive grid refactor:
The flat `gridRows`/`gridRowHeights` model in `PanelGrid.tsx` continues to work for all existing layouts. The recursive-tree refactor (state, rendering, resize, serialization, 4 e2e tests) is a substantial structural change requiring:
- Visual regression review across all multi-pane layouts in active use
- Storage migration tested against existing user data
- Layout-shift / CLS budget verification per `performance/spec.md`

**WONT-DO this cycle**. The architectural prep (types + migration helper) remains in the codebase ready to be picked up. Reopen as a discrete change when a concrete user need (e.g. deeply nested layouts beyond 2-col) creates pressure to ship.

Change archived in deferred state.
