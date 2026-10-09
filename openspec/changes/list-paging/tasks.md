# Tasks: list-paging

Lo stato di una traccia lo dà il suo test, non la casella.

- **T1** Controllore condiviso «carica quando entra in vista» e le quattro liste. Barra:
  `loadOnReach.test.ts`, `board-column-volume.spec.ts` (COLVOL-02, 04, 05, 06). Indipendente.
- **T2** Barra delle schede della finestra browser della topic. Barra:
  `topic-browser-tab-strip.spec.ts`, `topic-browser-window.spec.ts`. Indipendente.
- **T3** Spec: LIST-PAGE-01, TOPIC-BROWSER-01. Con T1 e T2.
