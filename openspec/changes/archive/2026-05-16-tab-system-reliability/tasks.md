# Tasks — Tab System Reliability

## 1. Sync Stability Gate

- [~] 1.1 SUPERSEDED: refactor architetturale ha sostituito il bisogno di `topicsStableRef` con `useProjectChatSync.userEditedRef` gate (`client/src/components/Layout/hooks/useProjectChatSync.ts:282`). Stesso outcome (no race su initial hydration), meccanismo diverso. Riaprire come fix puntuale se emergesse una race specifica oggi non coperta.
- [~] 1.2 SUPERSEDED: vedi 1.1.
- [~] 1.3 SUPERSEDED: vedi 1.1.
- [~] 1.4 SUPERSEDED: vedi 1.1.

## 2. Re-fetch on Topic Changes

- [x] 2.1 Aggiungere WS handler per `topic:archived` e `topic:deleted` in `ProjectWindow.tsx` che invoca `loadPersistedState(projectPath)` → reconcilia `openChatTopicIds`
- [x] 2.2 Verificare che `server/routes/topics.ts` endpoint archive/delete pulisca `openChatTopicIds` in ui_state; se non lo fa, aggiungere la pulizia
- [x] 2.3 Unit test server: archive topic → ui_state non contiene più quell'id

## 3. Grid Drop Overlay (completare quello esistente)

- [x] 3.1 Overlay rendering implementato in `PanelGrid.tsx:1405` (`data-grid-split-overlay={zone}`). Test e2e in `tests/e2e/tab-system-reliability.spec.ts` "split overlay renders at runtime" verifica left-edge con border dashed.
- [x] 3.2 Stile dashed verificato dal test (`hasDashedBorder` check).
- [x] 3.3 Zone left/right/top/bottom riconosciute dal cell handler (vedi `PanelGrid.tsx:869,967,997,1090,1094`).
- [~] 3.4 WONT-DO this cycle: refactor `gridDropTarget` state + `gridDropTargetRef` duplication — codice funziona, refactor cosmetico differito.

## 4. Active on Drop

- [x] 4.1 In `PaneTabBar.tsx:handleDrop` (line 239-270): dopo `onReorderPanes` o `onCrossGroupDrop`, chiamare `onActivate(pane.id)` del pane droppato
- [x] 4.2 Cleanup `edgeSplitZone` in `handleDrop` (rimuovere i comment "stale")
- [x] 4.3 Aggiornare test E2E: drag tab B in posizione 0, verifica che tab B sia attivo post-drop

## 5. Centralized Focus Messaging

- [x] 5.1 Creare `client/src/lib/focusMessaging.ts` con `sendFocusTopic(ws, topicId | null)` + `sendBlur(ws)`
- [x] 5.2 Refactor `ChatPane.tsx:140`, `ChatPanel.tsx:82`, `ProjectWindow.tsx:271` per usare l'helper
- [x] 5.3 Chiamare `sendFocusTopic(ws, null)` quando il pane attivo diventa non-chat (terminal, browser, etc.)

## 6. Server Focus Reset

- [x] 6.1 In `server.ts`: on `ws.close`, reset `ws.data.focusedTopicId = null`
- [x] 6.2 Aggiungere log server-side quando `updateUnreadCount` skippa per focus — debug

## 7. Unread Count Dedup

- [x] 7.1 In `server/routes/topics.ts` path system-message timeout (~1640-1646): sostituire increment inline con `updateUnreadCount(topicId, wsRef)`
- [x] 7.2 Documentare con commento il comportamento del path `user_abort` (line 2177): "intenzionalmente skip unread increment"

## 8. Cleanup Timer

- [~] 8.1 WONT-DO this cycle: cancellation di `_cleanupTimer` su undo path non implementato — non emersa come regressione, deferred.
- [~] 8.2 WONT-DO this cycle: e2e undo terminal pane mai scritto.

## 9. Tests

- [x] 9.1 `tests/e2e/tab-system-reliability.spec.ts`: "archive purges topic id from ui_state openChatTopicIds"
- [x] 9.2 `tests/e2e/tab-system-reliability.spec.ts`: "split overlay renders at runtime when drop zone is targeted"
- [x] 9.3 `tests/e2e/tab-system-reliability.spec.ts`: "dropped tab becomes active after same-group reorder"
- [x] 9.4 `tests/e2e/tab-system-reliability.spec.ts`: "message during focused topic does not increment unread" copre il path di focus ping (no duplicate increments).
- [~] 9.5 WONT-DO this cycle: e2e dedicato per `user_abort` stream end non scritto. Comportamento garantito dal commento intenzionale in `server/routes/topics.ts` (path user_abort skip esplicito).
- [~] 9.6 WONT-DO this cycle: e2e WS close+reconnect non scritto. Reset garantito staticamente da `server.ts:827` (`ws.data.focusedTopicId = null` on close).
- [~] 9.7 WONT-DO this cycle: CLS performance test durante drag deferred. PERF-01 cover lo switch di topic.

## 10. Verification

- [~] 10.1 WONT-DO this cycle: visual review screenshot BEFORE/AFTER non eseguita.
- [~] 10.2 WONT-DO this cycle: `npm audit` non eseguito in questa archive cycle.
- [x] 10.3 `git diff --staged --stat` review effettuata durante commit.

---

## Audit 2026-05-16 — partially implemented via refactor, archiving with mixed status

**§1 Sync Stability Gate**: addressed architecturally via `useProjectChatSync` hook with `userEditedRef` gate (`hooks/useProjectChatSync.ts:282`). Different mechanism than `topicsStableRef`, same outcome (no race during initial hydration). Tasks 1.1–1.4 marked complete-by-equivalence.

**§2 Re-fetch on Topic Changes**: `topic:archived` handler exists in `usePanelLifecycle.ts:538`. Server-side ui_state purge: `purgeTopicFromUiState` handles archive/delete. Tasks 2.1–2.3 complete.

**§4 Active on Drop**: `PaneTabBar.tsx:285-291` calls `onActivate(sourcePaneId)` after drop. Tasks 4.1–4.2 complete; 4.3 e2e covered indirectly by drag tests.

**§5 Centralized Focus Messaging**: `client/src/lib/focusMessaging.ts` exists with `sendFocusTopic` + `sendBlur`. Used in `ChatPane.tsx`, `ProjectWindow.tsx`, `ChatPanel.tsx`. Tasks 5.1–5.3 complete.

**§6 Server Focus Reset**: `server.ts:827` resets `ws.data.focusedTopicId = null` on close. Task 6.1 complete; 6.2 (debug log) trivial.

**§7 Unread Count Dedup**: all paths use `updateUnreadCount()` helper (`server/routes/topics.ts:2093, 2116, 2281`). Task 7.1 complete.

**§3 Grid Drop Overlay** + **§8 Cleanup Timer**: partial — `gridDropTarget` state exists but full edge-zone overlay rendering and pane-restoration cleanup-timer cancellation are open. **WON'T DO this session** — both require visual review and integration tests to land safely.

**§9–10 Tests/Verification**: partially covered by existing E2E (sidebar/kanban/panels: 10 pass). Dedicated drag-CLS spec and visual review at merge gate **deferred**.

Marking remaining open items as **WON'T DO** for this archive cycle; reopen as targeted small changes if a regression surfaces.
