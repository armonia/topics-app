# Acceptance — tab-bar-density

## Barra eseguibile

1. `bun test client/src/components/Layout/tabDensity.test.ts` esce 0. Casi: piena quando ci sta;
   compatta con la attiva >= 120 e le altre >= 76; quadratino con le non attive = altezza e la
   attiva >= 96; una tab sola mai oltre lo spazio e mai sotto il quadratino; monotona (meno spazio
   non dà mai una barra più larga); stesso input = stesso output.
2. `tests/e2e/tab-bar-density.spec.ts`, progetto `webkit`, video registrato. Un gruppo con 6 tab
   (chat, terminale, browser, file), la larghezza del gruppo portata a 1200 / 600 / 340 / 160 px:
   - DENS-01 a 1200: tutte alla larghezza piena di oggi;
   - DENS-02 a 600: nessuno scorrimento (`scrollWidth <= clientWidth`), attiva >= 120, ogni nome
     ha testo visibile;
   - DENS-03 a 340: non attive quadrate (larghezza = altezza ±1), attiva >= 96 col nome visibile,
     nessuno scorrimento, ogni quadratino ha un'icona o un'iniziale;
   - DENS-04 a 160 con una tab sola: dentro lo spazio, niente scorrimento;
   - DENS-05: il passaggio del puntatore su ogni tab non cambia nessuna larghezza;
   - DENS-06: chiusa una tab col puntatore nella barra, le altre restano ferme; uscito il
     puntatore, si ridistribuiscono;
   - DENS-07: il tooltip/`aria-label` di un quadratino porta il nome intero.
3. Mutazione su copia: `tabDensity` che torna sempre «piena» → DENS-02 e DENS-03 rossi.
4. Restano verdi in WebKit: `tab-*.spec.ts`, `project-tabs`, `browser-tab-chrome`, `pane-zoom`,
   `tab-bar-command-air`.
5. Cancelli: `typecheck:client`, `check:bloat`, `check:identifier-language` a 0.
