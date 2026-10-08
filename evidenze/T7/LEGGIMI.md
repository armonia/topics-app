# Evidenze T7 · immagini con il loro riquadro

Registrate il 08/10/2026 sulla VM cloud con `E2E_EVIDENCE=1 E2E_VIDEO=1 E2E_TIER=pr SERVER_HOST=127.0.0.1`,
`--project=chromium -g "immagine"`, sulle spec del ramo `cloud/t7-topic-immagini`:

- `prima/`: codice di `17a60e4` (partenza), con le spec nuove copiate sopra. CLS 0,0330 su tutte e tre le scene.
- `dopo/`: codice di `402c024`. CLS 0,0000 su tutte e tre.

Scene (l'immagine è trattenuta di proposito, 1-1,2 s, così si vede quando arriva):

- `chat-image-box-…-quando-l-immagine-si-carica`: un messaggio con un'immagine arriva dal server (`message:new`).
  Prima la riga entra bassa e si allunga di 133 px quando arrivano i byte; dopo entra già alta.
- `chat-image-box-…-quando-si-caricano`: le immagini di fine turno (`message:media`) aggiunte all'ultima risposta.
- `topic-visited-first-frame-…-gia-preso`: riapro una topic letta; una risposta con immagine è arrivata mentre ero via
  e la prima pagina del server è trattenuta 1,5 s.

`esperimento-layout-shift-ro.mjs`: lo scroller nudo che cresce di 300 px, con il pin nello stesso task, nel
ResizeObserver, nel rAF, o nessuno (risultato: 0 · 0,0197 · 0 · 0,0197). `node esperimento-layout-shift-ro.mjs`
dalla radice del repo.
