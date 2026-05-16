## Context

The panel validation effect in `App.tsx:626-672` runs whenever `topics` or `openPanels` change. It filters `openPanels` to remove stale entries. Structural tabs (project, browser, terminal, utility, draft) are identified by ID prefix and always survive. Topic tabs are plain UUIDs and require a `topics[id]` lookup — if the topic isn't in the map yet (race condition) or was transiently missing, the tab is silently dropped and cannot be recovered.

Two race windows exist:
1. **HMR reload**: React state reinitializes, topics loaded from localStorage cache which may lag behind `openPanels`
2. **Server panels overwrite**: `openPanels` saved to server with 2s debounce, but server fetch on mount overwrites localStorage immediately — if HMR fires within the debounce window, server has stale panel list

## Goals / Non-Goals

**Goals:**
- Topic tabs MUST survive HMR reloads and full page reloads
- Unknown panel IDs (probable topic UUIDs) MUST be preserved until definitively invalid
- No behavioral change for structural tabs or archived topic cleanup

**Non-Goals:**
- Changing the server sync debounce timing
- Modifying the project-linked topic → project pane conversion (that's intentional)
- Adding retry/recovery UI for lost tabs

## Decisions

### 1. Gate validation on `serverSyncedRef` in addition to `!topicsLoading`

**Choice**: Add `serverSyncedRef.current` to the validation guard so it won't run until both topics AND server panels are loaded.

**Why**: Prevents the window where cached topics are used for validation before the server response arrives. The ref already exists at `App.tsx:275`.

**Alternative**: Debounce the validation effect — rejected because it adds latency without solving the root cause.

### 2. Preserve UUID-shaped IDs that aren't in topics yet

**Choice**: In the validation filter, if an ID looks like a UUID (matches UUID pattern) but isn't in `topics`, keep it instead of dropping it. Only drop IDs that are definitively invalid (not a UUID, not a known prefix).

**Why**: A missing topic lookup is ambiguous — it could mean "not loaded yet" or "deleted". Keeping it is safe because the next validation pass (after topics fully load) will clean it up if truly invalid.

**Alternative**: Add a separate "pending" state for unresolved tabs — rejected as overengineered for this fix.

### 3. Add `isKnownPanePrefix()` helper to `paneConfig.ts`

**Choice**: Centralize the prefix check (`project:`, `browser:`, `terminal:`, `draft:`, `__`, `chat:`, `session-viewer:`, `process-log:`) into one function. IDs matching no prefix AND not UUID-shaped are the only ones dropped.

**Why**: The current inline check at line 637 is fragile — adding new pane types requires updating the filter. A helper is more maintainable.

## Risks / Trade-offs

- **Stale tabs could linger temporarily**: If a topic is truly deleted, its tab persists until the next successful `loadTopics()` completes. Acceptable — validation will clean it up within seconds.
- **UUID regex false positives**: An ID that happens to look like a UUID but isn't a topic would be preserved. Extremely unlikely given the app's ID generation patterns.
