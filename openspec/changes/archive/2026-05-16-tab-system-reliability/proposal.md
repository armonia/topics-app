## Why

Il sistema di tab (focus, drag, split, notifiche, sync) presenta bug inter-correlati che degradano l'esperienza utente:

1. **Tab perse su cambi Topics** — quando un WebSocket aggiorna/archivia/rinomina un topic, il re-render può eseguire la sync con un `topicIds` transitoriamente vuoto/stale, lasciando lo stato server incoerente con il client. Al reload, le tab validate falliscono e spariscono.
2. **Drag senza feedback sul grid** — `PanelGrid` traccia `gridDropTarget` solo in ref, non renderizza overlay per le zone left/right/top/bottom/center. Durante il drag l'utente non capisce dove finirà il tab.
3. **Active state non aggiornato su drop** — `onDrop` riordina ma non attiva il tab trascinato; `edgeSplitZone` ha cleanup stale.
4. **Race unread/focus** — tre sender diversi di `focus` WS, path `stream:end` con `reason:"user_abort"` senza `updateUnreadCount`, increment inline duplicato in un path timeout, `focusedTopicId` stale su disconnect.
5. **Timer cleanup terminal** — delete 60s fire anche dopo undo.

## What Changes

### Persistenza & Sync
- Non eseguire il sync `topicIds → panes` finché `topics` non è in uno stato stabile (caricamento completato + nessun update in-flight)
- Aggiungere guard: se `topicIds` è vuoto ma `topics` non lo è, skippare (già presente ma incompleto)
- Ri-fetchare lo stato server persistito quando arriva un evento `topic:archived` / `topic:removed` per riconciliare openChatTopicIds
- Prevenire il "double-run" di Flow A (server-fetch) e Flow B (topicIds-sync): marcare `initialChatsSyncedRef` in modo idempotente e non ripristinare da `persisted.current` dopo il primo successo

### Drag Feedback
- Rendere visibile un overlay semi-trasparente per le drop zone del grid (left/right/top/bottom/center) basato su `gridDropTarget` state
- Garantire che il tab in drag mantenga un'indicazione visiva (opacity, outline) anche sul target pane

### Active State & Drop
- In `handleDrop` di PaneTabBar, chiamare `onActivatePane` per il pane del tab droppato (sia same-group reorder sia cross-group)
- Centralizzare l'invio del messaggio `focus` WS in un singolo helper chiamato da ChatPane, ChatPanel, ProjectWindow

### Unread & Focus
- Aggiungere `updateUnreadCount()` al path `stream:end` con `reason:"user_abort"` (se design decision è "user_abort non conta come unread", documentarlo esplicitamente e rimuovere TODO)
- Sostituire l'increment inline nel path system-message timeout con chiamata a `updateUnreadCount()`
- Sul server: reset `focusedTopicId` su `ws.close` e su `ws.open` (evita stale cross-reconnect)

### Cleanup Timer
- Memorizzare il timer id nel pane record; cancellarlo se il pane viene ripristinato via undo prima dei 60s

## Capabilities

### Modified Capabilities
- `tab-sync-e2e`: aggiungere scenari per out-of-order topic updates e archive/rename/merge durante sessione attiva
- `project-tabs-e2e`: aggiungere scenari per drag feedback e active state post-drop
- `chat`: unread count consistente su tutti i path stream:end + focus centralizzato

### New Capabilities
- `tab-drag-visual-feedback`: overlay drop zone su grid durante drag di pane tab
- `tab-system-reliability`: contratto di consistenza sync tra topics state e persisted tabs

## Impact

- `client/src/components/Layout/ProjectWindow.tsx` — guard sync + re-fetch on topic delete
- `client/src/components/Layout/PanelGrid.tsx` — render overlay per drop zones
- `client/src/components/Layout/PaneTabBar.tsx` — activate on drop + cleanup edgeSplitZone
- `client/src/lib/focusMessaging.ts` (new) — helper centralizzato per WS focus
- `client/src/components/Chat/ChatPane.tsx`, `ChatPanel.tsx`, `ProjectWindow.tsx` — usano il nuovo helper
- `server/routes/topics.ts` — unread count su user_abort + dedup inline increment
- `server.ts` — reset focusedTopicId su close/open
- `tests/e2e/tab-system-reliability.spec.ts` (new) — copertura end-to-end dei 5 capitoli
