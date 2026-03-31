## 1. PanelGrid server fetch on mount

- [x] 1.1 Add useEffect in PanelGrid.tsx that fetches `/api/ui-state/grid-layout` on mount and applies the response when it differs from localStorage (setSoloTopicIds, setGridRows, setGridRowHeights)
- [x] 1.2 Add userEditedRef + mountedRef guards (same pattern as ProjectWindow) — set userEditedRef on persist effect after mount, skip server callback if user has already edited

## 2. E2E tests for split persistence and correctness

- [ ] 2.1 Add test to grid-split.spec.ts: Split Right creates side-by-side panels with col-resize divider, verify both tab bars are independent
- [ ] 2.2 Add test: Split Down creates vertically stacked panels with row-resize divider
- [ ] 2.3 Add test: split layout persists across reload — Split Right → wait for server save → reload → verify divider and panels restored
- [ ] 2.4 Add test: project-internal split persists across reload — Split Right in project window → save → reload → verify project split restored

## 3. Mixed layout and nested split tests

- [ ] 3.1 Add test: mixed project + chat split — open a project panel and a chat panel side by side (multi-column), verify both render with their own tab bars
- [ ] 3.2 Add test: project window with nested splits — within a project window, Split Right + Split Down to create 3+ panes in multi-row multi-column layout, verify all pane tab bars render
- [ ] 3.3 Add test: mixed layout persists across reload — project + chat multi-column split → server save → reload → verify both panels and divider restored
- [ ] 3.4 Add test: multi-row top-level grid — Split Down to create 2 rows, then Split Right in one row to create multi-column, verify row and column dividers coexist
