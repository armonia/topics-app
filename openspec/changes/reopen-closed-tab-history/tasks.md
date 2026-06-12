# Tasks — reopen-closed-tab-history

## 1. Reopen chord (renderer)
- [ ] 1.1 Bind `⇧⌘T` (primary) + keep `⌘⇧U` (alias) in `useKeyboardShortcuts.ts`; both `preventDefault`, both reopen `closedTabs[0]` via `handleReopenClosedTab`. Update the stale comment.
- [ ] 1.2 Fix the stale `⇧⌘T` comment in `ChatInput.tsx` (no behavior change).

## 2. Electron menu + IPC
- [ ] 2.1 `electron-app/main.ts`: add View → "Reopen Closed Tab" (`CmdOrCtrl+Shift+T`) → `mainWindow.webContents.send('reopen-closed-tab')`.
- [ ] 2.2 `electron-app/preload.ts`: expose `onReopenClosedTab(cb)` + `removeReopenClosedTabListener()` (mirror `onNavigateToTopic`).
- [ ] 2.3 `App.tsx`: subscribe to `electronAPI.onReopenClosedTab` and reopen the newest closed tab via the shared handler.

## 3. ⌘K unification (already shared) + hints
- [ ] 3.1 `CommandPalette.tsx`: first "Chiuse di recente" row hint `⌘⇧U` → `⇧⌘T`.
- [ ] 3.2 `KeyboardShortcuts.tsx`: reopen entry `⌘⇧U` → `⇧⌘T` (note alias).

## 4. Cleanup / DRY
- [ ] 4.1 Make `ClosedTabRecord` canonical in `closedTabRecord.ts`; `useClosedTabs.ts` imports it (remove duplicate interface). Keep the barrel export surface stable.

## 5. Tests
- [ ] 5.1 `closedStack.test.ts` (new, bun:test): FIFO bound, UNDO_CLOSE restore (groupIndex+focus+group recreate), PANE_ID_REMAP rewrites closedStack+tabOrderSnapshot, PUSH_CLOSED_RECORD seq+bound.
- [ ] 5.2 Extend `closedTabRecord.test.ts`: `reopenClosedTab` non-terminal returns the pane verbatim and cancels pending cleanup.
- [ ] 5.3 `reopen-closed-tab.spec.ts` (new, Playwright): close a tab → `⇧⌘T` reopens it; `⌘K` "Chiuse di recente" lists it and reopening works.

## 6. Verify
- [ ] 6.1 `tsc -b` clean (client) + `tsc` clean (electron-app).
- [ ] 6.2 `bun test` for the pane-state modules green.
- [ ] 6.3 Targeted Playwright run for the new + existing closed-tab specs.
- [ ] 6.4 Adversarial review over the diff.
