# Acceptance: infinite-scroll

Ciò che è verde resta verde: le e2e della chat (`chat-tail-first`, `chat-history-window`,
`history-page-budget`), della board, della finestra browser e della barra delle tab
(`tab-bar-command-air`, `reduced-motion-chrome-controls`), `bun run typecheck`, i `check:*`.

## Chat (CHAT-HIST-01)

`tests/e2e/chat-infinite-scroll.spec.ts`, Chromium e WebKit, video:

- **GIVEN** una chat di tre pagine aperta sulla coda
- **WHEN** chi legge risale con la rotella, a vista ferma dopo ogni colpo, e attraversa la fusione a passi di 12 px
- **THEN** il resto arriva senza click, con una richiesta sola
- **AND** nel fotogramma della fusione le righe si spostano al più del passo, nei fotogrammi dopo di 0 px (± 1 px)
- **AND** nessun fotogramma campionato (rAF) resta senza righe; CLS ≤ 0,01 dove misurabile (Chromium)
- **AND** scorrendo ancora si arriva al primo messaggio

`tests/e2e/chat-tail-first.spec.ts`: chi arriva in cima prima della rete trova la riga in attesa
(`aria-busy`) e il resto entra da solo, la riga letta spostata al più dell'altezza della riga.

## Liste con «mostra altri» (LIST-PAGE-01)

`client/src/lib/loadOnReach.test.ts` (le decisioni del controllore) e
`tests/e2e/board-column-volume.spec.ts` COLVOL-02 (la colonna Done della board):

- **WHEN** la riga «mostra altri» entra in vista scorrendo
- **THEN** arriva UNA pagina senza click, e dieci fotogrammi dopo la colonna ne ha ancora una sola in più
- **AND** una pagina vuota o fallita non fa partire un ciclo; durante un trascinamento la colonna non cresce

Mutazione: con il controllore che si fida del «in vista» di prima, due test unitari vanno rossi.

## Barra delle schede della finestra browser (TOPIC-BROWSER-01)

`tests/e2e/topic-browser-tab-strip.spec.ts`, WebKit e Chromium, video: quindici schede in una
finestra minimizzata, ognuna larga almeno 88 px, la barra aperta sulla scheda attiva, il «+» largo
24 px e raggiungibile, la prima scheda raggiunta scorrendo e attivata col click. Sul bundle di
produzione di prima il test è rosso: «page widths 17 × 15, expected ≥ 88».
