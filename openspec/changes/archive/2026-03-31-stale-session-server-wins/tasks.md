## 1. Fix projectLayoutSync to notify on fresh data

- [x] 1.1 Add optional `onUpdate` callback parameter to `loadProjectLayout()` in `client/src/lib/projectLayoutSync.ts` — callback fires when server data differs from what was returned from localStorage
- [x] 1.2 Update `fetchAndCacheProjectLayout()` to compare server response with initial localStorage value and invoke callback if different

## 2. Make ProjectWindow consume fresh server data

- [x] 2.1 In `ProjectWindow.tsx`, replace `useRef(loadPersistedState(...))` with a `useEffect` that calls `loadProjectLayout` with an `onUpdate` callback
- [x] 2.2 Add `userEditedRef` flag that's set to `true` on any user-initiated layout change (add pane, close pane, split, reorder) — skip `onUpdate` if flag is set
- [x] 2.3 When `onUpdate` fires, apply fresh state to `setPanes`, `setGroups`, `setRows`, `setRowHeights`, `setSidebarCollapsed`

## 3. E2E test for stale session recovery

- [x] 3.1 Add test to `tests/e2e/tab-sync.spec.ts`: seed stale project layout in server, set different state in localStorage, reload page, assert UI shows server state
