## Why

When a user reopens the app from a browser with stale localStorage (e.g., a tab closed hours ago), the app shows stale state briefly before the server fetch corrects it. Worse, `projectLayoutSync` fetches fresh data from the server but only updates the localStorage cache silently — it never triggers a UI re-render. This means project window layouts remain stale until the user interacts or the component remounts.

## What Changes

- Fix `projectLayoutSync.ts` to notify the UI when server data differs from what was initially painted from localStorage, triggering a re-render with fresh state
- Add E2E test verifying that stale localStorage is overridden by server state after load
- Ensure the "server wins" pattern is consistent across panels, panel-order, and project layouts

## Capabilities

### New Capabilities

### Modified Capabilities
- `layout`: The layout system's project layout sync will now re-render when server state differs from cached localStorage state

## Impact

- `client/src/lib/projectLayoutSync.ts` — add callback mechanism to notify consumers of fresh server data
- `client/src/components/Layout/ProjectWindow.tsx` — consume the callback to re-render with server data
- New E2E test in `tests/e2e/` verifying stale→fresh transition
- No API changes, no server changes
