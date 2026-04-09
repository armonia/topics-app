## 1. Pane ID Classification Helper

- [x] 1.1 Add `isKnownPanePrefix(id: string): boolean` to `client/src/lib/paneConfig.ts` — returns true for all structural prefixes (project:, browser:, terminal:, draft:, chat:, session-viewer:, process-log:, __)
- [x] 1.2 Add `isUUIDLike(id: string): boolean` to `client/src/lib/paneConfig.ts` — matches UUID v4 pattern

## 2. Fix Validation Guard

- [x] 2.1 Add `serverSyncedRef.current` to the validation effect guard at `App.tsx:627` — validation MUST NOT run until both topics loaded AND server panels fetched
- [x] 2.2 Replace inline prefix checks at `App.tsx:637` with `isKnownPanePrefix()` call

## 3. Preserve Unresolved Topic Tabs

- [x] 3.1 In the validation filter, if an ID is not a known prefix AND is UUID-like AND `topics[id]` is undefined (not found), preserve it instead of dropping it
- [x] 3.2 Keep existing behavior: drop if `topic.archived`, convert if `topic.projectPath`

## 4. Test

- [x] 4.1 Add E2E test: open a topic tab, trigger page reload, verify tab survives
- [x] 4.2 Add E2E test: verify archived topic tabs are still cleaned up after reload
