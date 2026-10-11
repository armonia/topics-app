# Tasks — mobile-kanban

Lo stato di ogni traccia lo dà il suo test, non la casella.

- [x] 1. Misura di partenza: audit WebKit (ui-audit + axe) a 390x844, 844x390, 820x1180, chiaro e scuro. Barra: i numeri della tabella in `proposal.md`.
- [x] 2. Barra che non scorre in verticale (`overflow-y-hidden`) e controlli a 44 col dito (`TOOLBAR_CONTROL_H`, `TOOLBAR_ICON_W`, Orchestratore). Barra: `board-mobile-phone.spec.ts` KANBAN-MOBILE-01 e 02; `kanbanTopbar.test.ts`.
- [x] 3. Campo di ricerca che è la riga sotto `sm`. Barra: KANBAN-MOBILE-02.
- [x] 4. Spazio sotto l'ultima card derivato dal composer (`columnClearance.ts`). Barra: KANBAN-MOBILE-04, `columnClearance.test.ts`, MOBILE-SCREEN-02/02b.
- [x] 5. Colonne che riempiono l'altezza (già vero, ora guardato). Barra: KANBAN-MOBILE-03.
- [x] 6. Chip delle card leggibili nel tema chiaro. Barra: KANBAN-MOBILE-05.
- [x] 7. Scheletro della board alto come la barra vera col dito (`BoardSkeleton.tsx`).
- [x] 8. Spec: KANBAN-12 modificato, KANBAN-MOBILE-01..05 nuovi; eccezioni obsolete tolte da `usability-audit.spec.ts`.
- [ ] Fuori da qui (altri rami o guscio): fasce laterali in orizzontale, chip `#` a 29x45 col dito.
