# Tracce

Ognuna ha la sua riga di barra in `specs/acceptance.md`. Ordine: T1 → T2 → T4 → T5 → T3 → T6 → T7. Il modello del layout non cambia: ogni traccia passa dalle funzioni che la griglia e la finestra di progetto già usano per dividere, spostare e pareggiare.

- [ ] 1.1 **T1 Dalla colonna si divide.** `components/Layout/gridPaneDrop.ts` decide dove atterra una pane per ogni sorgente (riga, tab, tessera, cella intera); `GroupLayout` legge una riga della colonna come la tab della pane che contiene. Un trascinamento dalla colonna su un bordo apre la pane (se chiusa) e la mette nella cella nuova. Barra: `gridPaneDrop.test.ts` + SPLIT-01.
- [ ] 2.1 **T2 Anteprima come impronta.** `DropOverlay` disegna la parte che la pane occuperà con icona e nome della sorgente; il centro è un contorno della cella. Barra: SPLIT-02.
- [ ] 3.1 **T3 Divisori da tastiera.** `SplitTree` Divider: `tabIndex=0`, `aria-valuenow`, frecce ±5% (Maiusc ±1%), Invio pareggia, contorno di fuoco. Barra: `splitKeyboard.test.ts` + SPLIT-04.
- [ ] 4.1 **T4 Testata della cella.** Solo con superficie divisa e tab di lato: icona, nome, Ingrandisci, Togli dallo split; trascinabile come una tab, clic = fuoco, testata accesa sulla cella col fuoco. Barra: SPLIT-03.
- [ ] 5.1 **T5 Disposizione in ogni foglio.** Riga, tab, titolo e testata: le quattro direzioni, Ingrandisci, Pareggia, Togli dallo split; «Apri a destra / in basso» per una riga non aperta. Barra: `tabSheetEntries.test.ts` + SPLIT-05.
- [ ] 6.1 **T6 Fuoco fra le celle.** ⌘⌥ + frecce sceglie la cella vicina per geometria (centro più vicino nella direzione). Barra: `splitKeyboard.test.ts` + SPLIT-06.
- [ ] 7.1 **T7 Mini mappa di progetto.** La riga del progetto mostra la mappa degli split interni. Barra: `SplitMiniMap.test.ts` + SPLIT-07.
