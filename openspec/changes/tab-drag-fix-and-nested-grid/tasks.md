## 1. Tab drag ghost image fix

- [x] 1.1 In PaneTabBar.tsx `handleTabDragStart`, create a lightweight DOM clone element styled as a tab preview and call `e.dataTransfer.setDragImage()` with it; clean up the element after dragend

## 2. GridNode recursive type

- [x] 2.1 Define `GridNode` type in `types/index.ts`: `{ type: 'row'|'col'|'leaf', children?: GridNode[], sizes?: number[], itemKey?: string }`
- [x] 2.2 Add migration function `flatGridToTree(gridRows, gridRowHeights)` that converts old `PanelGridRow[]` format to new `GridNode` tree
- [x] 2.3 Add tree utility functions: `findLeaf(tree, itemKey)`, `insertSplit(tree, targetKey, newKey, direction)`, `removeLeaf(tree, itemKey)`, `flattenKeys(tree)`

## 3. PanelGrid refactor to recursive model

- [ ] 3.1 Replace `gridRows`/`gridRowHeights` state with single `gridTree: GridNode` state, with localStorage + server persistence using new format
- [ ] 3.2 Update the sync effect (naturalGridItems → gridTree) to build/update tree structure instead of flat rows
- [ ] 3.3 Refactor `handleSplitPane` to use `insertSplit(tree, targetKey, newKey, direction)` for column-specific and row-specific splits
- [ ] 3.4 Update drop handlers to navigate and modify the tree
- [ ] 3.5 Update resize callbacks and `useGridResize` hook to work with tree paths instead of flat rowIdx/colIdx

## 4. Recursive rendering

- [ ] 4.1 Create recursive `<GridNodeView>` component (or inline recursive render function) that renders `row`/`col`/`leaf` nodes with proper flex layout and dividers
- [ ] 4.2 Wire dividers with `data-*` attributes encoding tree path for resize resolver

## 5. Persistence and migration

- [ ] 5.1 Update save effect to serialize `{gridTree, soloTopicIds}` to localStorage + server
- [ ] 5.2 On load, detect old format `{gridRows}` vs new format `{gridTree}` and auto-migrate

## 6. E2E tests

- [ ] 6.1 Add test: tab drag does not trigger file drop behavior (drag tab, verify no file drop overlay)
- [ ] 6.2 Add test: Split Down below specific column creates nested layout (2-col → split one → verify both divider types)
- [ ] 6.3 Add test: nested split layout persists across reload
- [ ] 6.4 Add test: legacy flat format auto-migrates on load
