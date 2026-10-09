# Acceptance: infinite-scroll

Ciò che è verde resta verde: le e2e della chat (`chat-tail-first`, `chat-history-window`,
`history-page-budget`, `tab-switch-instant`, `chat-compact-drain`), `bun run typecheck`, i `check:*`.

## Chat (CHAT-HIST-01)

`tests/e2e/chat-infinite-scroll.spec.ts`, Chromium e WebKit, video:

- **GIVEN** una chat di tre pagine aperta sulla coda
- **WHEN** chi legge risale con la rotella, a vista ferma dopo ogni colpo (e la quiete che la fusione aspetta), e attraversa la soglia a passi di 12 px
- **THEN** il resto arriva senza click, con una richiesta sola
- **AND** la fusione cade a lista ferma: le righe si spostano di 0 px (± 1 px)
- **AND** nessun fotogramma campionato (rAF) resta senza righe; CLS ≤ 0,01 dove misurabile (Chromium), contando gli spostamenti che si vedono a schermo
- **AND** scorrendo ancora si arriva al primo messaggio

`tests/e2e/chat-tail-first.spec.ts`: chi arriva in cima prima della rete trova la riga in attesa
(`aria-busy`) e il resto entra da solo, la riga letta spostata al più dell'altezza della riga.

Aggiunti con la fusione a lista ferma (T4, traccia T20), nello stesso file, ognuno rosso sul bundle
di `3bad7e0e8` e verde dopo, su Chromium e WebKit:

- PagSu, Shift+Spazio, Home, e Home con il resto in ritardo di 1500 ms: dal fotogramma prima della
  fusione ai venti dopo il testo dei messaggi letti non si sposta più di 1 px, campionato in rAF e
  dopo i ResizeObserver dell'app; nessun fotogramma vuoto intorno alla fusione; una richiesta;
- due chat nella stessa finestra: si sale nella fascia della fusione con la risposta trattenuta, si
  passa all'altra scheda, la risposta arriva, si torna: stesso messaggio in cima, offset entro 2 px;
- dopo una fusione con la rotella il «↓» non porta un numero e il banner dei nuovi non c'è.
