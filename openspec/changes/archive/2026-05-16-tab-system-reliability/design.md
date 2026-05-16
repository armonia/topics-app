# Design — Tab System Reliability

## Context

Il sistema di tab è cresciuto in modo incrementale: persistenza layout localStorage, persistenza identità server (ui_state), drag nativo HTML5, notifiche unread server-driven, focus tracking via WebSocket. Ogni sottosistema è stato patchato singolarmente (vedi archive: `fix-topic-tab-persistence`, `tab-drag-fix-and-nested-grid`, `split-screen-sync-and-tests`, `unread-clear-and-scroll-fix`). Questa change risolve i bug residui di **interazione tra sottosistemi**.

## Decisioni

### 1. Sync stability gate (Topics → Panes)

**Problema**: `useEffect([topicIds, topics])` fires su ogni update di `topics`. Tra un update parziale (WS `topic:updated`) e il re-render, `topicIds` può essere transitorio.

**Decisione**: introdurre un `topicsStableRef` che diventa `true` solo dopo:
- Prima fetch `GET /api/topics` completata
- Nessun update in-flight da > 100ms (debounce)

Il sync effect esegue solo se `topicsStableRef.current === true`. Gli altri path (click utente, apertura tab) non sono gated.

**Alternative considerate**:
- *Lock globale su update topics*: troppo invasivo, impatta tutti i consumer
- *Rimuovere la sync effect e gestire solo in click*: perderemmo la pulizia automatica di tab su archive

### 2. Re-fetch on topic delete/archive

**Problema**: server mantiene `openChatTopicIds` con topic fantasma dopo archive; al reload falliscono.

**Decisione**: handler WS dedicato in `App.tsx` o `ProjectWindow.tsx`: su `topic:archived` o `topic:deleted`, invocare `loadPersistedState` per riconciliare (il server deve già aver rimosso il topic da openChatTopicIds — se non lo fa, è una fix server-side separata).

**Impatto server**: in `server/routes/topics.ts`, l'endpoint archive/delete deve pulire `openChatTopicIds` dallo ui_state di tutti i client che lo referenziano. Se non è presente, aggiungerlo.

### 3. Drag visual feedback

**Problema**: `PanelGrid.gridDropTarget` state non renderizzato.

**Decisione**: aggiungere un componente `GridDropOverlay` che legge `gridDropTarget` e renderizza un div assoluto con:
- Background `bg-primary/10`
- Border `border-2 border-primary border-dashed`
- Posizionamento dinamico basato su zone (`left` → metà sinistra, `right` → metà destra, `top`/`bottom` similarmente, `center` → nessun overlay perché delegato a children)

Opacity e transition 150ms per smooth feedback.

### 4. Centralized focus messaging

**Problema**: 3 componenti inviano `{type:"focus", topicId}` indipendentemente.

**Decisione**: `client/src/lib/focusMessaging.ts`:
```ts
export function sendFocusTopic(ws, topicId: string | null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "focus", topicId }));
}
```

Più: logica di "blur" (invia `topicId: null`) quando il tab attivo diventa non-chat. Evita `focusedTopicId` stale dopo che utente passa a terminal/browser.

### 5. Active on drop

**Problema**: drop riordina ma non attiva.

**Decisione**: in `PaneTabBar.handleDrop` (line 239-270), alla fine del riordino chiamare `onActivate(paneId)` con l'id del pane droppato. Questo risolve anche la percezione "non si capisce quale tab è in focus" post-drop.

### 6. Unread count consistency

**Problema**: path divergenti in `topics.ts`.

**Decisione**:
- Path `user_abort` (line 2177): la semantica è "user ha cliccato stop". Design choice: **non incrementa unread** (utente era presente). Aggiungere comment esplicito. Nessuna modifica funzionale.
- Path system-message timeout (~1640): sostituire increment inline con `updateUnreadCount()` per dedup.
- Server `ws.close`: reset `focusedTopicId = null` per evitare stale read.

### 7. Cleanup timer cancellation

**Decisione**: il timer viene già salvato in `record._cleanupTimer` (`ProjectWindow.tsx:766`). Aggiungere: in ogni path che "undo" o ripristina un pane, `clearTimeout(record._cleanupTimer)` e settare a `undefined`.

## Risks & Trade-offs

- **Gate di stabilità** può ritardare la pulizia di tab stale di ~100ms — accettabile, molto meglio di perdere tab.
- **Overlay drop zone** aggiunge un DOM node durante drag — impatto perf trascurabile, solo durante drag attivo.
- **Focus centralized** cambia 3 call site — regressione possibile se dimentichiamo un sender. Mitigazione: test E2E che verifica `focusedTopicId` lato server per ogni scenario di focus.

## Migration Plan

Nessuna migrazione dati. Tutti i cambiamenti sono runtime-level. Compatibilità con client precedenti mantenuta (server accetta comunque il formato `focus` esistente).
