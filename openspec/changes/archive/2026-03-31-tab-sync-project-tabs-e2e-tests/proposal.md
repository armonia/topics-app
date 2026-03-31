## Why

The app has tab synchronization (localStorage + server via ui-state API + WebSocket broadcast) and project-specific tab/layout management, but existing E2E tests only cover basic tab bar interactions (close, context menu, add pane). There is no test coverage for the sync round-trip (state persists and restores across reload), project window tabs, or cross-client WebSocket sync.

## What Changes

- Add E2E tests verifying tab state persistence: open tabs survive page reload via server sync
- Add E2E tests for project window tab management: opening project panes, switching tabs within project windows
- Add E2E tests for tab sync via WebSocket: layout changes broadcast and reflect across sessions
- Add E2E tests for preview (transient) tab behavior: single-click opens preview, double-click pins

## Capabilities

### New Capabilities
- `tab-sync-e2e`: E2E test coverage for tab state persistence (localStorage + server round-trip), WebSocket-driven cross-client sync, and reload restoration
- `project-tabs-e2e`: E2E test coverage for project window tab management including project-specific pane groups, sub-panel navigation, and project tab status badges

### Modified Capabilities

## Impact

- New test files in `tests/e2e/`
- New or extended test fixtures in `tests/e2e/fixtures/`
- No production code changes — test-only
