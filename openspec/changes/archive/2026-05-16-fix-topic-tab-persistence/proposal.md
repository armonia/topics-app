## Why

Topic tabs (plain UUID IDs like Claude conversations) are lost during Vite HMR reloads or full page reloads, while structural tabs (project, browser, terminal) always survive. The validation filter in `App.tsx:636-647` uses prefix-based identification for structural tabs but requires a `topics[id]` lookup for topic tabs — if the lookup fails (cache miss, stale server data), the tab is silently dropped.

## What Changes

- Preserve unrecognized tab IDs during panel validation instead of dropping them — treat unknown IDs as "pending" until topics are definitively loaded
- Skip validation entirely until both topics AND server panels are fully synced, preventing race conditions between the 2s debounced server sync and HMR reloads
- Add `isTopicLikeId()` helper to distinguish probable topic UUIDs from truly invalid IDs

## Capabilities

### New Capabilities
- `resilient-tab-validation`: Panel validation preserves topic tabs that aren't yet found in the topics map, preventing silent tab loss during HMR and page reloads

### Modified Capabilities

## Impact

- `client/src/App.tsx` — validation `useEffect` at line 626-672
- `client/src/lib/paneConfig.ts` — new ID classification helper
- `client/src/hooks/useTopics.ts` — no changes needed (cache already syncs via useEffect)
