## 1. Test Fixtures & Helpers

- [x] 1.1 Create `tests/e2e/fixtures/tab-sync.fixture.ts` with helpers: `getTabLabels()`, `waitForSyncPut()` (intercept PUT to `/api/ui-state`), `clearUiState()` (reset via API), `openPaneByType()`
- [x] 1.2 Extend existing `tests/e2e/helpers.ts` with `openTopicByClick()` (single-click for preview) and `openTopicByDoubleClick()` (double-click for pin)

## 2. Tab Sync Persistence Tests

- [x] 2.1 Create `tests/e2e/tab-sync.spec.ts` with test for TAB-SYNC-01: open tabs survive reload (open multiple tabs → wait for sync PUT → reload → assert same tabs)
- [x] 2.2 Add test: closed tab does not reappear after reload
- [x] 2.3 ~~Add test: tab order persists after reload~~ (skipped — requires dnd-kit pointer event simulation not yet in test infrastructure)
- [x] 2.4 Add test: server receives PUT to `/api/ui-state` when tab state changes

## 3. WebSocket Cross-Client Sync Tests

- [x] 3.1 Add multi-context test for TAB-SYNC-02: tab opened in context A appears in context B (two browser contexts, open tab in A, assert in B via WebSocket)
- [x] 3.2 Add multi-context test: tab closed in context A is removed in context B

## 4. Preview Tab Behavior Tests

- [x] 4.1 Add test for TAB-SYNC-03: single-click sidebar topic opens preview tab (italic styling)
- [x] 4.2 Add test: preview tab is replaced by next single-click
- [x] 4.3 Add test: double-click pins preview tab, next open creates new preview

## 5. Project Tabs Tests

- [x] 5.1 Create `tests/e2e/project-tabs.spec.ts` with test for PROJECT-TABS-01: project window displays tab bar with default pane
- [x] 5.2 Add test: add pane via (+) menu adds a new tab to project window
- [x] 5.3 Add test: switch between project pane tabs changes content area
- [x] 5.4 Add test: close project pane tab removes it and activates adjacent

## 6. Project Tab Persistence Tests

- [x] 6.1 Add test for PROJECT-TABS-02: project pane tabs persist after reload
- [x] 6.2 Add test: project split layout persists after reload

## 7. Project Tab Status Badges Tests

- [x] 7.1 Add test for PROJECT-TABS-03: project tab shows git modified file count badge
- [x] 7.2 Add test: project tab shows running process count badge
