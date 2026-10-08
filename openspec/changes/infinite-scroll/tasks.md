# Tasks: infinite-scroll

Lo stato di una traccia lo dà il suo test, non la casella.

- **T1** Virtuoso 4.18.1 → 4.18.16. Barra: le e2e della chat esistenti verdi su Chromium e WebKit.
- **T2** Go/no-go: il prepend con `firstItemIndex` su 4.18.16, misurato fotogramma per fotogramma
  (spostamento della riga letta, fotogrammi vuoti, CLS). Dipende da T1. Esito: go.
- **T3** Chat: il resto in arrivo da solo risalendo, la riga in cima in attesa se la rete è più
  lenta. Barra: `chat-infinite-scroll.spec.ts`, `chat-tail-first.spec.ts`. Dipende da T2.
- **T4** Controllore condiviso «carica quando entra in vista» e le quattro liste. Barra:
  `loadOnReach.test.ts`, `board-column-volume.spec.ts` (COLVOL-02). Indipendente.
- **T5** Barra delle schede della finestra browser della topic. Barra:
  `topic-browser-tab-strip.spec.ts`, `topic-browser-window.spec.ts`. Indipendente.
- **T6** Spec: CHAT-HIST-01, TOPIC-BROWSER-01, LIST-PAGE-01. Con T3, T4, T5.
