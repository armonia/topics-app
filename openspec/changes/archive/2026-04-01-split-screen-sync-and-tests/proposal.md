## Why

The top-level grid split layout (PanelGrid) saves to the server but never reads back on load — it only uses localStorage. If a user opens the app from a different browser/device, splits are lost. Project-internal splits (ProjectWindow) already sync via the onUpdate callback pattern. Additionally, there's no E2E test coverage for split persistence across sessions or for multi-column/multi-row split scenarios.

## What Changes

- Add server fetch + onUpdate callback to PanelGrid for grid-layout restoration (same pattern as ProjectWindow)
- Add userEdited guard to prevent overwriting user changes during fetch
- Add E2E tests for: split persistence across reload (both top-level and project-internal), vertical splits (Split Down), horizontal splits (Split Right), and multi-column layouts

## Capabilities

### New Capabilities

### Modified Capabilities
- `layout`: PanelGrid will now fetch grid-layout from server on load and apply fresh data when it differs from localStorage, matching the existing ProjectWindow pattern

## Impact

- `client/src/components/Layout/PanelGrid.tsx` — add server fetch with onUpdate callback for grid layout restoration
- New/extended E2E tests in `tests/e2e/grid-split.spec.ts`
- No API or server changes
