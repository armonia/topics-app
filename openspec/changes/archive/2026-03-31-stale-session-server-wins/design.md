## Context

The app uses a "fast paint" pattern: read localStorage for instant render, then fetch from server asynchronously. For top-level panels (`App.tsx`), the server fetch correctly calls `setOpenPanels()` to re-render. But for project layouts (`projectLayoutSync.ts`), the async fetch only updates localStorage silently — `ProjectWindow.tsx` reads the stale ref once at mount and never checks for updates.

## Goals / Non-Goals

**Goals:**
- Make `loadProjectLayout` notify consumers when server data arrives and differs from cache
- Make `ProjectWindow` re-render with fresh server data when it differs from what was initially painted
- Add E2E test verifying stale state gets replaced by server state

**Non-Goals:**
- Changing the fast-paint pattern (localStorage first is correct for perceived performance)
- Adding conflict resolution (server already wins — we just need to apply it to the UI)
- Syncing grid layout from server (separate concern)

## Decisions

**1. Add an `onUpdate` callback to `loadProjectLayout`**
Instead of fire-and-forget, `loadProjectLayout` accepts an optional callback that fires when the server response differs from what was returned initially. This keeps the API minimal and backwards-compatible.

```typescript
export function loadProjectLayout(
  localKey: string,
  projectPath: string,
  onUpdate?: (freshState: any) => void
): any | null
```

**2. ProjectWindow uses the callback to set fresh state**
In `ProjectWindow.tsx`, pass an `onUpdate` callback that calls the state setters (`setPanes`, `setGroups`, `setRows`, etc.) with the fresh server data — same logic as initial load, but triggered asynchronously.

**3. Guard against user edits during fetch**
If the user has already interacted (added/closed tabs, split panes) before the server response arrives, the fresh data should NOT overwrite their changes. Use a `userEditedRef` flag: set to `true` on any user-initiated layout change, and skip the onUpdate callback if set.

## Risks / Trade-offs

- **Brief layout shift**: When server data differs, the UI will re-render. This is the correct behavior (showing fresh state) but may cause a brief visual shift. Acceptable tradeoff vs showing permanently stale state.
- **userEditedRef timing**: If the user edits during the ~200ms fetch window, we skip the server update. This is conservative and safe — the user's local changes will be saved to server on the next debounced write.
