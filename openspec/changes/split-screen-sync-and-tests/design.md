## Context

PanelGrid reads grid layout (soloTopicIds, gridRows, gridRowHeights) from localStorage on mount. It saves to both localStorage (immediate) and server (`/api/ui-state/grid-layout`, 2s debounce). But it never fetches from the server on load. ProjectWindow already implements the correct pattern via `loadProjectLayout` with an `onUpdate` callback.

## Goals / Non-Goals

**Goals:**
- PanelGrid fetches `/api/ui-state/grid-layout` on mount and applies it when it differs from localStorage
- Add userEdited guard (same pattern as ProjectWindow) to avoid overwriting in-flight user changes
- E2E tests for split persistence and split correctness (vertical, horizontal, multi-column)

**Non-Goals:**
- Real-time cross-tab sync via WebSocket (future enhancement)
- Changing the 2s debounce timing

## Decisions

**1. Direct fetch in PanelGrid useEffect**
Unlike ProjectWindow which uses `projectLayoutSync.ts`, PanelGrid's sync is simpler (single key, no per-project hashing). A direct `fetch('/api/ui-state/grid-layout')` in a mount useEffect with comparison against localStorage is sufficient.

**2. userEdited guard via persist effect**
Same pattern as ProjectWindow: a `mountedRef` tracks first render, and a `userEditedRef` is set on subsequent persist effect fires. The server fetch callback skips if user has already edited.

**3. E2E tests in existing grid-split.spec.ts**
Extend the existing file rather than creating a new one. Add cross-session persistence tests and multi-split correctness tests.

## Risks / Trade-offs

- **Layout shift on fresh data**: Same acceptable tradeoff as ProjectWindow — brief visual shift when server state replaces stale cache is correct behavior.
