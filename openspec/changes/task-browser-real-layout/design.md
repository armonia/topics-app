# Design — task-browser-real-layout

## Il seam: perché il motore di layout è riusabile task-scoped

Il motore di tiling vero è **presentazionale, puro su dati + callback** — nessuna
scrittura al pane store globale:

| Componente | Accoppiamento al pane store | Note |
|---|---|---|
| `GroupLayout` (`Layout/GroupLayout.tsx:24-90`) | ❌ nessuno | props = `panes/groups/rows/rowHeights/focusedGroupId` + callback; nessun import di `state/pane`. Costruisce `buildShallowGridTree(rows, rowHeights)` → `<SplitTree>` |
| `SplitTree` (`Layout/SplitTree.tsx`) | ❌ puro | `LayoutNode` + `renderLeaf` + `onResize/onEqualize` |
| `state/layout/layoutTree`, `splitController`, `legacyAdapters` | ❌ zero import | algebra pura |
| `groupLayoutStacks`, `gridWidths` | ❌ puri | helper di reconcile/stack riusati |
| `PaneTabBar` (`Layout/PaneTabBar.tsx:57-156`) | ⚠️ solo lo Spazi-submenu | dispatch a `usePaneStore` SOLO se si passa `canMoveToSpace`; le altre letture (`useSpawnedBrowserMap`/`useTopics`/`useTerminalSessions`) sono read-only e per una pane `browser:<task-…>` tornano vuote |
| `RemoteBrowserPanel` (`Browser/RemoteBrowserPanel.tsx:27-62`) | ❌ | già usato oggi in `TaskBrowserSurface`; riporta attività sotto `paneId = 'browser:'+contextId` |

Tutto l'accoppiamento al pane store vive nel *producer* `useProjectLayout`
(`Layout/hooks/useProjectLayout.ts`) — terminal sync, WS `browser:navigate`, tombstone,
undo store-based, orphan reconcile. **Non lo riusiamo.** Alimentiamo `GroupLayout` con uno
stato di layout task-scoped e instradiamo i callback in un controller che persiste nella
ui-state key del task. Le pane del task **non entrano mai** in `pane-store-v2` (nessun
`OPEN_PANE`, nessun broadcast WS, nessun tombstone) → l'invariante di
`taskBrowserTabs.ts:5-19` è preservata.

## Modello dati (nessuna migration)

`taskBrowserTabs` resta la **sorgente di verità dell'identità** delle tab
(`contextId = task-<id8>-<seq>`, url, title, seq). Aggiungiamo:

- **Soft-close**: la chiusura non rimuove la tab dallo store ma la marca `parked: true`.
  Le tab `parked` non compaiono nel layout ma restano come **anteprime** sotto la
  descrizione, riapribili. Hard-remove esplicito solo dal cestino dell'anteprima.
- **Stato di layout per-task** (nuovo, in un sibling `taskBrowserLayout.ts` o come campo
  del payload esistente): `{ groups: PaneGroup[], rows: GroupLayoutRow[], rowHeights:
  number[], focusedGroupId: string | null }`, persistito con la STESSA meccanica LWW
  debounced di `taskBrowserTabs` (`taskBrowserTabs.ts:160-219`) nella key
  `task-browser-tabs:<taskId>` (o `task-browser-layout:<taskId>`). È un **descrittore di
  vista** che referenzia `paneId = browser:<contextId>`; l'identità resta nelle tab.

### Mapping tab → Pane

```
tab (contextId=task-<id8>-<seq>, url, title, titleSource?) →
  Pane { id: `browser:${contextId}`, type: 'browser', stableKey: contextId, url, title, titleSource }
```

`browser` è un `PaneType` di prima classe (`state/pane/types.ts:23`). Nessun id di store
richiesto: `GroupLayout`/`PaneTabBar` chiavano su `pane.id`/`stableKey`. Tutte le tab del
task sono `type:'browser'` → un solo `PaneGroupType` (quello che
`paneTypeToGroupType('browser')` restituisce), quindi `availableTypesForGroup` offre solo
`'browser'` e `onAddPaneToGroup('browser')` → `taskBrowserTabs.addTab`.

## L'hook `useTaskBrowserLayout(taskId)`

Ritorna le props per `GroupLayout` + handler, tutto derivato/task-scoped:

- `panes`: `taskBrowserTabs.tabs` (non parcheggiate) mappate a `Pane`.
- `groups/rows/rowHeights/focusedGroupId`: dallo stato layout persistito, passati per una
  **reconciliation** (il cuore del lavoro, subset browsers-only di `useProjectLayout`
  `:691-905`):
  - ogni tab non ancora presente in alcun gruppo → appesa al gruppo focussato (o al primo);
  - gruppi/righe che referenziano contextId spariti (chiusi/parked) → potati;
  - larghezze/altezze preservate con `keepColumnWidths`/`appendColumnWidths` (gridWidths) e
    `reconcileCellStacks`/`pickCellStacks` (groupLayoutStacks) — gli STESSI helper puri del
    producer reale, senza i rami terminal/chat/preview.
- handler portati quasi verbatim dal producer (trasformazioni pure di stato):
  `onActivatePane`, `onClosePane`→`taskBrowserTabs.closeTab` (soft), `onAddPaneToGroup`→
  `addTab`, `onReorderGroupPanes`, `onMovePaneBetweenGroups`, `onSplitGroup`
  (`gridWidths`+`groupLayoutStacks`, cap `MAX_COLS_PER_ROW`/`MAX_ROWS`), `onReorderRows`,
  `onUpdateRows`, `onUpdateRowHeights`→persist, `onRenameBrowser`→`updateTab`+pin
  (`titleSource='user'`). Undo split/flatten via `pushUndo` con snapshot plain-data (come
  `GroupLayout.tsx:648-669`).
- `renderPane(pane, _focused, isVisible)` → `RemoteBrowserPanel` (thread `isVisible`,
  `onUrlChange`/`onTitleChange`→`taskBrowserTabs.updateTab`), identico a
  `TaskDetail.tsx:1288-1294` ma dentro le celle del layout.
- `dndScope = 'task:'+taskId`: i drag restano confinati alle bar del task (la guardia di
  scope esiste già, `GroupLayout.tsx:245-249`), impossibile trascinare una tab del task
  fuori o una tab d'app dentro.

## Wiring in TaskDetail

- Quando c'è ≥1 tab browser non-parcheggiata, il gruppo browser è renderizzato via
  `<GroupLayout {...useTaskBrowserLayout(taskId)} />` al posto del ramo `browser` di
  `SurfaceContent`/`TaskTabBar`.
- **Piano / media / Output** restano su `SurfaceContent` (non sono `PaneType`). Il motore
  reale si applica SOLO al gruppo browser. La `surfaces` list perde i `kind:'browser'`
  quando il motore reale è attivo (li gestisce `GroupLayout`), mantiene plan/media/output.
- **Anteprima sotto la descrizione**: striscia fissa (sempre montata quando il task ha
  tab, anche parked) con una mini-card per tab: favicon/host + titolo, click = riapri
  (unpark + attiva nel layout), × = hard-remove. Vive tra la descrizione e l'albero
  sottotask.
- **Layout stretto vs largo**: il `wide`/side-panel di oggi resta la cornice; il gruppo
  browser vive nel pannello quando largo, o inline quando stretto (una sola colonna → il
  motore degrada a tab-strip singola, ma è lo STESSO `PaneTabBar`).

## Paletti (dove "proprio lo stesso" NON si applica)

- **Pop-out** (`onPopOut`) NON passato: una app-window è un pane globale → sconfinerebbe
  in `pane-store-v2`. Disabilitato per il gruppo browser del task.
- **`canMoveToSpace`** NON passato: è l'unico path che dispatcha `SPACE_UPSERT` nel pane
  store (`PaneTabBar.tsx:1173,1191-1195`). Omesso ⇒ dead code.
- **`onSettings`/`onToggleFissato`/`onPinPane`** omessi: semantica topic/app-level non
  applicabile a una tab browser task-scoped.

## Graduazione dei flag

- Client `TASK_BROWSER_ENABLED` (`TaskDetail.tsx:23`) → default `true` (localStorage resta
  come override/kill-switch, ma l'assenza di chiave = ON).
- Server `TOPICS_TASK_BROWSER` (`routes/topics.ts:204`) → default ON (env `='0'` come
  kill-switch). Il fork `browser:open-task-tab` diventa il path normale; il comportamento
  del broadcast è invariato, cambia solo che ora è sempre attivo.

## Rischi & mitigazioni

1. **Reconciliation** (rischio #1): tab doppie / sparite / celle vuote. Mitigazione: riuso
   degli helper puri esistenti + suite `taskBrowserLayout.test.ts` sul modello di
   `groupLayoutStacks.test.ts` (append orfani, prune, split, move, resize, unpark).
2. **Bounds del WKWebView nativo sotto tiling+resize nel drawer**: più celle live + drag
   dei divisori + fold wide/narrow. `RemoteBrowserPanel` gate su `isVisible` +
   keep-alive `display:none` (`GroupLayout.tsx:855-871`) e gli eventi di resize-freeze
   (`topics:pane-resize-start/-end`, `SplitTree.tsx:201/234`) esistono già. Verifica LIVE
   guidando la Tauri app (rischio nativo, non deducibile dai test) — split, resize, fold.
3. **Letture incidentali di store in `PaneTabBar`**: un prop truthy di troppo
   (`canMoveToSpace`/`onPopOut`) reintrodurrebbe l'accoppiamento. Guardato nel wiring +
   in review.

## Test

- `client/src/state/taskBrowserLayout.test.ts` (bun:test, modulo puro): reconcile
  append/prune, split col/row con cap, move cross-group, reorder, resize weights, soft-close
  (parked non nel layout ma nell'anteprima), unpark riapre nella cella giusta, hard-remove.
- `taskBrowserTabs.test.ts` esteso: `parked` non rompe `addTab/upsertTab/closeTab/sanitize`.
- E2E mirato (Playwright, board): flag ON di default → apri task con browser tab, split,
  chiudi (finisce in anteprima), riapri dall'anteprima. (Il rendering nativo vero si
  verifica a mano sulla Tauri app.)
- Verifica: `bunx tsc -b` verde (client+server), lint, `bun test` mirati verdi.
