## Context

The app persists tab/layout state through a layered system: localStorage for fast paint, server `ui_state` table for durability, and WebSocket broadcasts (`ui-state:updated`, `ui-state:init`) for cross-client sync. Project windows manage their own pane groups with per-project persistence keyed by path hash. Existing E2E tests cover basic tab bar UI but not the sync pipeline or project-specific tabs.

## Goals / Non-Goals

**Goals:**
- Verify tab state round-trip: open tabs → reload → tabs restored from server
- Verify project window tabs: project panes open, switch, and persist correctly
- Verify preview tab behavior: transient tabs replaced on next open, pinned tabs kept
- Verify WebSocket sync: layout change on one page context reflects via broadcast

**Non-Goals:**
- Testing multi-device sync (same-browser multi-tab is sufficient proxy)
- Performance benchmarking of sync debounce timing
- Testing localStorage directly (implementation detail)

## Decisions

**1. Test against real server, not mocked routes**
Tests hit `http://localhost:3333` with real SQLite persistence. This validates the full round-trip (client → API → DB → WebSocket → client) rather than just UI state. Mocking would miss integration bugs in the sync pipeline.

**2. Use page reload to verify persistence**
After making tab changes, `page.reload()` then assert tabs are restored. This is the most reliable way to test server-side persistence without coupling to localStorage implementation.

**3. Use Playwright's multi-context for WebSocket sync tests**
Open two browser contexts pointing at the same app. Make a change in context A, assert the broadcast arrives in context B. This tests real WebSocket delivery without mocking.

**4. Test files organization**
- `tests/e2e/tab-sync.spec.ts` — sync persistence and cross-context broadcast
- `tests/e2e/project-tabs.spec.ts` — project window tab management

**5. Fixture for tab state helpers**
Extend existing `tests/e2e/fixtures/` with helpers for opening specific pane types, reading tab labels, and waiting for sync completion.

## Risks / Trade-offs

- **Flaky sync timing**: Debounce is 2s for server writes → tests must wait sufficiently after tab changes before reload. Mitigation: intercept the PUT request to `/api/ui-state` and wait for response.
- **State leakage between tests**: Prior test's tab state could affect next test. Mitigation: clear ui_state via API before each test or use unique project contexts.
- **WebSocket race in multi-context**: Broadcast may arrive before assertion is set up. Mitigation: set up waitForEvent before triggering the change.
