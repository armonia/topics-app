# Proposal — task-browser-real-layout

## Why

Il browser di proprietà del task (memory `task-owned-browser-tabs`) vive nel drawer del
Kanban (`client/src/components/Board/TaskDetail.tsx`) come **gruppo multi-tab scoped al
task**, tenuto di proposito FUORI da `pane-store-v2` per non riaprire la classe di bug
identità-pane (tombstone / LWW / `PURGE_ORPHAN_PANE` / `browserSingletonReducer` /
divergenza contextId). Il prezzo di quella scelta è stato un **mini-sistema di layout
parallelo**: `TaskTabBar` è, testuale nel codice (`TaskDetail.tsx:1196`), *"a lightweight,
task-scoped version of the app's PaneTabBar"*. Conseguenze:

- Niente tiling reale: nessun split, drag-to-split, tab-stack, resize dei divisori,
  affiancamento di due browser del task. C'è solo "una tab attiva alla volta" (inline nel
  body stretto, o singola surface nel side panel largo).
- Doppio linguaggio di UI da mantenere: `TaskTabBar`/`SurfaceContent` diverge dal vero
  `PaneTabBar`/`GroupLayout` che l'utente già conosce nel resto dell'app.
- La feature è dietro **due flag spenti** (`localStorage['board:taskBrowser']` + env
  `TOPICS_TASK_BROWSER`): in produzione l'utente reale vede solo il singolo iframe Output
  inerte — il multi-tab browser non esiste.
- Chiudere una tab la **distrugge** (`taskBrowserTabs.closeTab` la rimuove dallo store):
  non c'è modo di rivederla/riaprirla, e non c'è un'anteprima persistente delle superfici
  del task quando il gruppo non è a fuoco.

**Il paradosso**: il motore di layout vero dell'app (`GroupLayout` + `SplitTree` +
`PaneTabBar` + `state/layout/layoutTree`) è già **render-puro su dati + callback** — non
importa né scrive mai `pane-store-v2`. Tutto l'accoppiamento al pane store globale vive nel
*producer* `useProjectLayout` (hook di progetto), che NON serve riusare. Si può quindi
alimentare `GroupLayout` con un albero di layout **task-scoped** + `Pane[]` derivati da
`taskBrowserTabs`, ottenendo tiling/split/drag/resize veri, **senza** che una sola pane del
task entri nel pane store globale. (Feasibility validata con un pass architetturale, vedi
`design.md`.)

## What Changes

Il gruppo browser del task passa dal mini-`TaskTabBar` al **motore di layout reale**,
scoping-lo al task:

- **Riuso as-is** (zero modifiche): `GroupLayout`, `SplitTree`, `PaneTabBar`,
  `state/layout/layoutTree`, `splitController`, `groupLayoutStacks`, `gridWidths`,
  `RemoteBrowserPanel`.
- **Nuovo (colla task-scoped, pura e testabile)**: lo stato di layout per-task
  (`groups`/`rows`/`rowHeights`/`focusedGroupId`) persistito nella STESSA ui-state key di
  `taskBrowserTabs` (LWW debounced già presente), + hook `useTaskBrowserLayout(taskId)` che
  deriva `panes: Pane[]` (`type:'browser'`, `stableKey = task-<id8>-<seq>`) da
  `taskBrowserTabs` e instrada ogni callback (close/add/reorder/split/move/resize) in un
  controller task-scoped. Cuore del lavoro = **reconciliation** pane↔group↔row
  browsers-only (subset di `useProjectLayout`, riusando gli helper puri esistenti) con
  test tipo `groupLayoutStacks.test.ts`.
- **Il motore vero si applica SOLO al gruppo browser.** Piano / media / Output restano
  sulla surface leggera (`SurfaceContent`): non sono `PaneType`, forzarli in `PaneTabBar`
  è controproducente.
- **Anteprima riapribile sotto la descrizione con soft-close**: chiudere una tab la
  parcheggia come anteprima cliccabile in una striscia fissa sotto la descrizione del task
  invece di distruggerla; da lì la si riapre nel layout. Sempre visibile (anche quando il
  gruppo browser non è a fuoco), così il "quando chiuso mostralo comunque per riaprirlo /
  in anteprima" è soddisfatto.
- **Graduazione dei flag a default-ON**: la feature esiste per l'utente reale
  (client + server), mantenendo il fork server dell'agent invariato nel comportamento.

## Non-Goals

- **Pop-out verso una finestra reale**: è l'UNICO gesto che sconfinerebbe legittimamente in
  `pane-store-v2` (una app-window è un pane globale). Resta disabilitato/scoped per il
  gruppo browser del task. Riconsiderare solo con un percorso dedicato.
- **Portare Piano / media / Output nel motore reale**: non sono `PaneType`; restano sulla
  surface leggera. Nessun fake-PaneType.
- **Toccare `pane-store-v2`, i suoi reducer/middleware o il fork server dell'agent**: il
  comportamento server (`browser:open-task-tab`) è invariato; cambia solo come il client
  renderizza il gruppo.
- **Persistenza nativa cross-drawer (ex-"Fase 3")**: la sopravvivenza della sessione
  WKWebView alla chiusura del drawer resta fuori scope; qui si unifica il layout, non il
  keep-alive board-level.

## Impact

- `client/src/state/taskBrowserTabs.ts` — soft-close (parcheggio invece di rimozione) +
  eventuale sibling `taskBrowserLayout.ts` (stato layout per-task + persistenza).
- `client/src/components/Board/TaskDetail.tsx` — il gruppo browser rendered via
  `GroupLayout`; striscia anteprima sotto la descrizione; Piano/media/Output invariati
  sulla surface leggera.
- `client/src/components/Board/constants.ts` — `TaskSurface` (il gruppo browser esce dalla
  lista surface leggere quando il motore reale è attivo).
- **Zero** modifiche a `GroupLayout`/`SplitTree`/`PaneTabBar`/`layoutTree`/pane store.
- **Nessuna migration** (persistenza via ui-state, come oggi). Flag graduati a default-ON.
- Spec: ADDED `KANBAN-11` (delta in `specs/kanban/spec.md` di questa change).
