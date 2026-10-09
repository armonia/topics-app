# Tasks: infinite-scroll

Lo stato di una traccia lo dà il suo test, non la casella.

- **T1** Virtuoso 4.18.1 → 4.18.16. Barra: le e2e della chat esistenti verdi su Chromium e WebKit.
- **T2** Go/no-go: il prepend con `firstItemIndex` su 4.18.16, misurato fotogramma per fotogramma
  (spostamento della riga letta, fotogrammi vuoti, CLS). Dipende da T1. Esito: go.
- **T3** Chat: il resto in arrivo da solo risalendo, la riga in cima in attesa se la rete è più
  lenta. Barra: `chat-infinite-scroll.spec.ts`, `chat-tail-first.spec.ts`. Dipende da T2.
- **T4** Fusione solo a riposo, ri-ancoraggio esatto, contatore «↓» che conta solo il fondo. Barra:
  i tre gruppi di test di `specs/acceptance.md` in `chat-infinite-scroll.spec.ts`, verdi su Chromium
  e WebKit (traccia T20, REPORT in `cloud-quality-pass/reports/T20.md`). Dipende da T3.
- **T5** Spec: CHAT-HIST-01. Con T3 e T4.
