# Split da zero: un gesto, tre superfici

## Perché
Misurato il 24/11 sull'app vera (dati di prova, 1440 px):
- **Dalla colonna non si divide.** Con le tab di lato (il default dal 24/11) trascinare una riga sul bordo destro, in basso o in alto della griglia mostra sempre «dentro questa pane», un velo blu su tutta la cella: `PanelGrid.tsx` sceglie `center` per ogni trascinamento che parte dalla colonna. Lo split si fa solo dalla barra in alto, che di lato non c'è.
- **Il foglio della riga non ha Disposizione** (`TabSheetBody.tsx`, solo barra e titolo): di lato lo split si raggiunge dal titolo in alto e da nessun'altra parte.
- **Due grammatiche.** Al primo livello il centro sposta la chat nella cella, nella finestra di progetto la aggiunge come tab; la riga intera si raggiunge da strisce di 26 px che compaiono solo durante il trascinamento; dividere a sinistra o in alto da menu non esiste.
- **Di lato, una cella divisa non dice cosa contiene** e non dice quale ha il fuoco: senza barra non c'è testata.
- **I divisori non si usano da tastiera** (`role=separator` senza fuoco né valore) e la mini mappa non c'è per gli split dentro un progetto.

## Cosa cambia
1. **Un vocabolario su ogni superficie** (griglia, finestra di progetto) e da ogni sorgente (riga della colonna, tab, tessera fissata, testata della cella): bordo della cella = dividi da quel lato; centro = apri qui; bordo della superficie = riga o colonna intera. Al tetto dei 4 × 4 il bordo di quell'asse non si offre.
2. **L'anteprima è l'impronta vera**: la parte che la pane occuperà, con icona e nome di ciò che porti; il centro è un contorno, non un velo su tutta la cella.
3. **Testata della cella** quando la superficie è divisa e le tab stanno di lato: icona, nome, Ingrandisci, Togli dallo split. Si trascina come una tab, il clic dà il fuoco, la cella col fuoco ha la testata accesa.
4. **Divisori**: filo a riposo, accento in hover e trascinamento, doppio clic pareggia; da tastiera Tab ci arriva, le frecce spostano del 5%, Invio pareggia, il valore si legge (`aria-valuenow`).
5. **Disposizione in ogni foglio** (riga, tab, titolo, testata): Dividi a destra, a sinistra, in basso, in alto; Ingrandisci; Pareggia; Togli dallo split. Una riga non aperta offre «Apri a destra» e «Apri in basso».
6. **Fuoco fra le celle da tastiera**: ⌘⌥ + frecce.
7. **Mini mappa anche per gli split dentro un progetto**, sulla riga del progetto.

Resta tutto ciò che c'è: gli scenari di LAYOUT-01, la colonna impilata contro la riga intera, il tetto 4 × 4, il doppio clic che pareggia, lo zoom (corredo e sola cella), gli spazi, gli split fluttuanti, la persistenza, nessun ricaricamento quando una pane cambia cella (SPLITPERF-01), il telefono senza split.

## Barra
`specs/acceptance.md`: test unitari per traccia, `tests/e2e/split-da-zero.spec.ts` con video SPLIT-01..07, mutazioni sui punti critici, e prima/dopo a 375, 768, 1440 e 3440 px. Ciò che è verde resta verde (le spec di split esistenti girano in CI).

## Fuori
- Il modello del layout (righe, gruppi, colonne impilate, persistenza, sincronizzazione): resta, cambia ciò che si vede e si fa.
- Una libreria di docking (dockview): valutata, non adottata, perché vorrebbe dire riscrivere motore e persistenza per un cambio di interfaccia.
- Telefono, spazi, split fluttuanti, navigatore del task: com'è.

## Deciso dall'agente
- Riferimenti di comportamento (non di stile): VS Code (cinque zone per gruppo più il bordo della finestra), dockview (zone ai bordi del contenitore, anteprima come impronta), Arc (split trascinando dalla colonna, testata per pane), lo schema WAI-ARIA Window Splitter (separatore con fuoco, frecce, Invio).
- Il centro su una cella a una pane «apre qui»: la pane che c'era resta aperta nel serbatoio, un drop non chiude mai niente.
- La testata compare solo se la superficie è divisa: con una cella sola il titolo in alto basta.

## Non ancora specificato
- Ordine e nomi delle voci di Disposizione: si giudicano sulla schermata.
