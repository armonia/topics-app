# Tasks — task-browser-real-layout

Convenzione: chiudere ogni fase con typecheck verde + test della change verdi.
Il motore di layout (`GroupLayout`/`SplitTree`/`PaneTabBar`/`layoutTree`/`splitController`/
`groupLayoutStacks`/`gridWidths`/`RemoteBrowserPanel`) si RIUSA as-is — nessuna modifica.

## Phase 1 — Soft-close nello store tab (client/src/state/taskBrowserTabs.ts)
- [ ] Campo `parked?: boolean` su `TaskBrowserTab`; `closeTab` marca `parked:true` invece
      di rimuovere (l'attivo scivola sul vicino non-parked); nuovo `unparkTab` (riapre +
      attiva) e `removeTab` (hard-remove, per il cestino dell'anteprima).
- [ ] `sanitizeTaskTabs` accetta/coerce `parked`; `addTab`/`upsertTab` gestiscono il
      re-open di una tab parked (unpark idempotente).
- [ ] Test `taskBrowserTabs.test.ts`: parked non compare nel set attivo, unpark/remove,
      round-trip sanitize con parked.

## Phase 2 — Stato + reconciliation layout task-scoped (client/src/state/taskBrowserLayout.ts)
- [ ] Store per-task `{ groups, rows, rowHeights, focusedGroupId }` con la stessa
      persistenza LWW debounced di taskBrowserTabs (ui-state key per-task).
- [ ] `reconcileTaskLayout(tabs, layout)` (puro): append tab senza gruppo, prune gruppi/
      righe con contextId sparito/parked, preserva widths/heights via
      `keepColumnWidths`/`appendColumnWidths` + `reconcileCellStacks`/`pickCellStacks`.
- [ ] Handler puri (subset browsers-only di useProjectLayout): reorderGroupPanes,
      movePaneBetweenGroups, splitGroup (cap MAX_COLS_PER_ROW/MAX_ROWS via gridWidths+
      groupLayoutStacks), reorderRows, updateRows, updateRowHeights.
- [ ] Test `taskBrowserLayout.test.ts` (modello groupLayoutStacks.test.ts): append/prune,
      split col+row, move cross-group, reorder, resize, unpark→cella.

## Phase 3 — Hook useTaskBrowserLayout (client/src/components/Board/hooks/ o accanto)
- [ ] Deriva `panes: Pane[]` (browser:<contextId>, stableKey, url, title, titleSource) da
      taskBrowserTabs; espone props GroupLayout + handler cablati sullo store/reconcile.
- [ ] `renderPane` → RemoteBrowserPanel (isVisible, onUrlChange/onTitleChange→updateTab);
      `onClosePane`→closeTab(soft); `onAddPaneToGroup('browser')`→addTab;
      `onRenameBrowser`→updateTab+titleSource='user'; `dndScope='task:'+taskId`.
- [ ] NON passare `onPopOut`/`canMoveToSpace`/`onSettings`/`onToggleFissato`.

## Phase 4 — Wiring in TaskDetail.tsx
- [ ] Il gruppo browser rendered via `<GroupLayout {...useTaskBrowserLayout(taskId)} />`
      (wide: nel side panel; narrow: inline). Rimuovere il ramo `browser` da
      TaskTabBar/SurfaceContent; Piano/media/Output restano sulla surface leggera.
- [ ] `surfaces` (constants.ts TaskSurface): niente `kind:'browser'` quando il motore reale
      è attivo; restano output/plan/media.
- [ ] Striscia anteprima sotto la descrizione (sopra l'albero sottotask): mini-card per
      ogni tab (attiva e parked) con host/titolo, click=unpark+attiva, ×=removeTab.

## Phase 5 — Graduazione flag a default-ON
- [ ] Client `TASK_BROWSER_ENABLED` default true (assenza chiave = ON; localStorage='0'
      resta kill-switch).
- [ ] Server `TOPICS_TASK_BROWSER` default ON (env='0' kill-switch) in routes/topics.ts.

## Phase 6 — Verifica
- [ ] `bunx tsc -b` verde (client + server).
- [ ] lint client verde sui file toccati.
- [ ] `bun test` mirato verde: taskBrowserTabs, taskBrowserLayout (+ suite pane/layout non
      regredite).
- [ ] E2E board mirato (build client in public/ → :13334): apri task con browser tab,
      split, soft-close→anteprima, riapri dall'anteprima.
- [ ] Verifica LIVE sulla Tauri app (rendering nativo): split + resize divisori + fold
      wide/narrow senza drift dei bounds WKWebView. (Non landare la parte nativa alla cieca.)
