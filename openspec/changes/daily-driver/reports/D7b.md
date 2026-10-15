# D7b · Client dopo riavvio del server

**Barra prima.** Lo scenario già esistente riavviava il server e aspettava i 25 chunk, ma non imponeva un intervallo offline e non verificava reload, chunk duplicati o identità delle pane.

**Barra dopo.** La spec richiede 2.500 ms di server spento, tutti i chunk `1..25` una sola volta e in ordine, streaming concluso, nessun nuovo evento `load` e gli stessi ID pane. `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0 (5/5 controlli). E2E e mutazione non eseguiti: vietati sul Mac dal brief, riservati alla CI.

## Fatto

- Scenario `@nightly` in `tests/e2e/chat-join-mid-turn.spec.ts`: tiene la pagina aperta durante il riavvio, lascia il server spento 2.500 ms mentre il turno lento prosegue e asserisce sequenza completa senza duplicati, fine streaming, nessun reload e array degli ID pane invariato. Prova statica: `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0.
- `restartTestServer` accetta una durata offline opzionale, usata solo da questo scenario. `git diff --check` exit 0.

## Trovato e non fatto

- Esecuzione browser con video e mutazione del recupero della chat aperta non verificate in locale: il brief vieta questa e2e sul Mac e indica il workflow CI «Clip di consegna». Servono esecuzione CI con video e prova che la variante mutata diventi rossa.

## Rifiutato

- Nessuna modifica al codice di reconnect: `useReconnectCatchUp` è già collegato alla riapertura effettiva del socket e ricarica le chat aperte. Il punto mancante era la copertura delle condizioni D7b, non un difetto dimostrato nel recupero.
