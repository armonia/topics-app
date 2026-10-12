# Acceptance: list-paging

Ciò che è verde resta verde: le e2e della board, della finestra browser e della barra delle tab
(`topic-browser-window`, `tab-bar-command-air`, `reduced-motion-chrome-controls`,
`tab-switch-instant`), delle liste toccate (`notification-history`, `git-commit-history`,
`chat-resume-picker`), `bun run typecheck`, i `check:*`.

## Liste con «mostra altri» (LIST-PAGE-01)

`client/src/lib/loadOnReach.test.ts` (le decisioni del controllore) e
`tests/e2e/board-column-volume.spec.ts` (la colonna Done della board), WebKit:

- **WHEN** la riga «mostra altri» entra in vista scorrendo
- **THEN** arriva UNA pagina senza click, e dieci fotogrammi dopo la colonna ne ha ancora una sola
  in più (COLVOL-02)
- **AND** passare da griglia a lista non carica niente da solo (COLVOL-04), una colonna fuori
  schermo aspetta anche a una finestra alta (COLVOL-05), da griglia a lista conta la riga, non
  la cima della colonna (COLVOL-06), e tornata alla griglia la colonna carica ancora 240 px
  prima della riga (COLVOL-07)
- **AND** una pagina vuota o fallita non fa partire un ciclo; durante un trascinamento la colonna
  non cresce

Mutazione: con il controllore che si fida del «in vista» di prima, tre test unitari su sei vanno rossi.
COLVOL-06 è rosso sul bundle di prima (il contenitore guardato era quello della griglia), COLVOL-07
sul bundle di 9f6d5fe74 (tornata la griglia, il contenitore guardato restava quello della lista).

## Barra delle schede della finestra browser (TOPIC-BROWSER-01)

`tests/e2e/topic-browser-tab-strip.spec.ts`, WebKit, video: quindici schede in una finestra
minimizzata, ognuna larga almeno 88 px, la barra aperta sulla scheda attiva, il «+» largo 24 px e
raggiungibile, la prima scheda raggiunta scorrendo e attivata col click; minimizzata e riaperta,
la scheda attiva resta in vista. Sul bundle di produzione di prima il primo test è rosso: «page
widths 17 × 15, expected ≥ 88».
