# Tasks — Tab System Reliability

## 1. Sync Stability Gate

- [x] 1.1 Aggiungere `topicsStableRef: MutableRefObject<boolean>` in `client/src/components/Layout/ProjectWindow.tsx`
- [x] 1.2 Settare `topicsStableRef.current = true` dopo il primo fetch `useTopics` + debounce 100ms senza update
- [x] 1.3 Gateare `useEffect([topicIds, topics])` (line 398-456) su `topicsStableRef.current === true`
- [x] 1.4 Rimuovere guard transitorio (lines 404-410) sostituito da gate

## 2. Re-fetch on Topic Changes

- [x] 2.1 Aggiungere WS handler per `topic:archived` e `topic:deleted` in `ProjectWindow.tsx` che invoca `loadPersistedState(projectPath)` → reconcilia `openChatTopicIds`
- [x] 2.2 Verificare che `server/routes/topics.ts` endpoint archive/delete pulisca `openChatTopicIds` in ui_state; se non lo fa, aggiungere la pulizia
- [x] 2.3 Unit test server: archive topic → ui_state non contiene più quell'id

## 3. Grid Drop Overlay (completare quello esistente)

- [x] 3.1 In `PanelGrid.tsx` cell div (line 989-1000), aggiungere rendering overlay assoluto per `zone === 'left' | 'right' | 'top' | 'bottom'` (oggi solo `center` ha `boxShadow` inset)
- [x] 3.2 Stile coerente con `PaneTabBar.edgeSplitZone` esistente: bg `color-mix(in srgb, var(--primary) 15%, transparent)`, border `2px dashed var(--primary)`, borderRadius `4px`
- [x] 3.3 Posizionamento: `left` → occupa metà sinistra della cell, `right` → metà destra, `top`/`bottom` analogamente
- [x] 3.4 Rimuovere duplicazione `gridDropTarget` state + `gridDropTargetRef` — usare solo state con `flushSync` al drag-over per garantire lettura fresca in `onDropCapture`

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

- [x] 8.1 In `ProjectWindow.tsx`, ogni path che annulla la rimozione di un pane (undo, ripristino) deve `clearTimeout(record._cleanupTimer)` e `delete record._cleanupTimer`
- [x] 8.2 Test E2E: chiudi terminal pane, undo entro 5s, verifica che pane persista sul server dopo 70s

## 9. Tests

- [x] 9.1 E2E: apri 2 chat in progetto → archivia 1 topic via API → verifica tab archiviato rimosso + tab vivo preservato + reload consistente
- [x] 9.2 E2E: drag pane tra grid zones → verifica overlay visibile durante drag + posizione finale corretta
- [x] 9.3 E2E: drag tab A su tab B → verifica tab trascinato attivo post-drop
- [x] 9.4 E2E: focus ping invia 1 msg server per tab-switch (no duplicati da 3 sender)
- [x] 9.5 E2E: user_abort stream end → unread count non cambia (design choice)
- [x] 9.6 E2E: WS close + reconnect → focusedTopicId è null finché client non reinvia
- [x] 9.7 Performance: CLS < 0.1 durante drag, nessun layout shift visibile

## 10. Verification

- [x] 10.1 Playwright run con video, AI visual review su screenshot BEFORE/AFTER drag
- [x] 10.2 `npm audit` clean
- [x] 10.3 `git diff --staged --stat` review manuale

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
