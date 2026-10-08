# T7b — Topic: il sipario non aspetta più un'immagine che ha già il suo riquadro

**GOAL.** Una topic visitata con un'immagine in vista si scopre senza aspettare i byte
dell'immagine, e chi allega un'immagine la vede entrare col suo spazio già preso. CLS ≤ 0,01 resta.

Parti da `reports/T7.md`, sezione «Trovato e non fatto», punti 1 e 3: li ha trovati T7, che ha
consegnato il riquadro (`client/src/components/Chat/mediaBox.ts`, `mediaSizes` dal server).

## Cosa fai

1. **Il sipario** (`client/src/components/Chat/listPaintedAndWhole.ts`): oggi aspetta ogni `<img>`
   in vista non ancora caricata. Un'immagine che ha già il riquadro (lo stile di `useMediaBox`
   finché non arriva il `load`) non sposta niente quando arriva: il sipario non la aspetta più.
   Le immagini senza riquadro (remote, SVG, server vecchio) restano aspettate come oggi. Finché i
   byte non arrivano il riquadro deve leggersi come un posto per un'immagine, non come un buco:
   decidi tu come (sfondo neutro del tema, niente animazioni che spostano), chiaro e scuro.
2. **La bolla di chi allega**: la bolla ottimistica disegna l'immagine prima della riga del server
   e senza `mediaSizes`. Le dimensioni il client le ha già nel `File` del composer
   (`createImageBitmap` o equivalente): mettile sulla bolla con la stessa chiave che userà
   `MediaImage`. Il composer è in rami aperti di altri: tocca il minimo e scrivi nel REPORT dove.

## Barra (si esegue uguale all'inizio e alla fine)

- **B1 sipario:** scena nuova in `topic-visited-first-frame.spec.ts`: topic visitata, l'ultima
  risposta ha un'immagine 900×500 coi byte trattenuti 1,5 s. Tempo dal clic sul tab al sipario
  alzato, prima e dopo (almeno 5 corse per lato): dopo non aspetta i byte (sipario alzato prima
  che il trattenuto finisca); CLS ≤ 0,01 sulla stessa scena.
- **B2 bolla:** scena nuova in `chat-image-box.spec.ts`: allego un PNG 900×500 e invio, il servizio
  dell'immagine trattenuto 1,2 s; CLS della bolla prima/dopo, dopo ≤ 0,01.
- **B3 mutazioni** (copia scratch, mai il file vero): togli il salto del sipario → B1 rosso; togli
  le dimensioni dalla bolla → B2 rosso.
- **B4 verde resta verde:** `topic-*.spec.ts`, `chat-*.spec.ts`, `*cls*.spec.ts`, `refresh-cls`,
  `pane-return-cls` in Chromium; `qa-gate.sh --veloce`; unit del client toccato. Se tocchi codice
  server, anche su Bun 1.3.8 (`_comuni.md`).

## Consegna

Ramo `cloud/t7b-topic-sipario`, REPORT in `openspec/changes/cloud-quality-pass/reports/T7b.md`,
video Chromium delle due scene prima/dopo.

**FUORI.** L'immagine scritta a metà streaming (serve un campo nel protocollo), `/api/topics/:id/messages`,
server, migrazioni, il resto del composer.
