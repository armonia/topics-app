# Tasks — Tab System Reliability

## 1. Sync Stability Gate

- [ ] 1.1 Aggiungere `topicsStableRef: MutableRefObject<boolean>` in `client/src/components/Layout/ProjectWindow.tsx`
- [ ] 1.2 Settare `topicsStableRef.current = true` dopo il primo fetch `useTopics` + debounce 100ms senza update
- [ ] 1.3 Gateare `useEffect([topicIds, topics])` (line 398-456) su `topicsStableRef.current === true`
- [ ] 1.4 Rimuovere guard transitorio (lines 404-410) sostituito da gate

## 2. Re-fetch on Topic Changes

- [ ] 2.1 Aggiungere WS handler per `topic:archived` e `topic:deleted` in `ProjectWindow.tsx` che invoca `loadPersistedState(projectPath)` → reconcilia `openChatTopicIds`
- [ ] 2.2 Verificare che `server/routes/topics.ts` endpoint archive/delete pulisca `openChatTopicIds` in ui_state; se non lo fa, aggiungere la pulizia
- [ ] 2.3 Unit test server: archive topic → ui_state non contiene più quell'id

## 3. Grid Drop Overlay (completare quello esistente)

- [ ] 3.1 In `PanelGrid.tsx` cell div (line 989-1000), aggiungere rendering overlay assoluto per `zone === 'left' | 'right' | 'top' | 'bottom'` (oggi solo `center` ha `boxShadow` inset)
- [ ] 3.2 Stile coerente con `PaneTabBar.edgeSplitZone` esistente: bg `color-mix(in srgb, var(--primary) 15%, transparent)`, border `2px dashed var(--primary)`, borderRadius `4px`
- [ ] 3.3 Posizionamento: `left` → occupa metà sinistra della cell, `right` → metà destra, `top`/`bottom` analogamente
- [ ] 3.4 Rimuovere duplicazione `gridDropTarget` state + `gridDropTargetRef` — usare solo state con `flushSync` al drag-over per garantire lettura fresca in `onDropCapture`

## 4. Active on Drop

- [ ] 4.1 In `PaneTabBar.tsx:handleDrop` (line 239-270): dopo `onReorderPanes` o `onCrossGroupDrop`, chiamare `onActivate(pane.id)` del pane droppato
- [ ] 4.2 Cleanup `edgeSplitZone` in `handleDrop` (rimuovere i comment "stale")
- [ ] 4.3 Aggiornare test E2E: drag tab B in posizione 0, verifica che tab B sia attivo post-drop

## 5. Centralized Focus Messaging

- [ ] 5.1 Creare `client/src/lib/focusMessaging.ts` con `sendFocusTopic(ws, topicId | null)` + `sendBlur(ws)`
- [ ] 5.2 Refactor `ChatPane.tsx:140`, `ChatPanel.tsx:82`, `ProjectWindow.tsx:271` per usare l'helper
- [ ] 5.3 Chiamare `sendFocusTopic(ws, null)` quando il pane attivo diventa non-chat (terminal, browser, etc.)

## 6. Server Focus Reset

- [ ] 6.1 In `server.ts`: on `ws.close`, reset `ws.data.focusedTopicId = null`
- [ ] 6.2 Aggiungere log server-side quando `updateUnreadCount` skippa per focus — debug

## 7. Unread Count Dedup

- [ ] 7.1 In `server/routes/topics.ts` path system-message timeout (~1640-1646): sostituire increment inline con `updateUnreadCount(topicId, wsRef)`
- [ ] 7.2 Documentare con commento il comportamento del path `user_abort` (line 2177): "intenzionalmente skip unread increment"

## 8. Cleanup Timer

- [ ] 8.1 In `ProjectWindow.tsx`, ogni path che annulla la rimozione di un pane (undo, ripristino) deve `clearTimeout(record._cleanupTimer)` e `delete record._cleanupTimer`
- [ ] 8.2 Test E2E: chiudi terminal pane, undo entro 5s, verifica che pane persista sul server dopo 70s

## 9. Tests

- [ ] 9.1 E2E: apri 2 chat in progetto → archivia 1 topic via API → verifica tab archiviato rimosso + tab vivo preservato + reload consistente
- [ ] 9.2 E2E: drag pane tra grid zones → verifica overlay visibile durante drag + posizione finale corretta
- [ ] 9.3 E2E: drag tab A su tab B → verifica tab trascinato attivo post-drop
- [ ] 9.4 E2E: focus ping invia 1 msg server per tab-switch (no duplicati da 3 sender)
- [ ] 9.5 E2E: user_abort stream end → unread count non cambia (design choice)
- [ ] 9.6 E2E: WS close + reconnect → focusedTopicId è null finché client non reinvia
- [ ] 9.7 Performance: CLS < 0.1 durante drag, nessun layout shift visibile

## 10. Verification

- [ ] 10.1 Playwright run con video, AI visual review su screenshot BEFORE/AFTER drag
- [ ] 10.2 `npm audit` clean
- [ ] 10.3 `git diff --staged --stat` review manuale
