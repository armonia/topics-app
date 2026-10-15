# D7f · Prova a due dispositivi del pane-store

**Barra prima:** Bun 1.4.2; `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0; `bun run lint` exit 0, 4 warning preesistenti e 0 errori.

**Barra dopo:** `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0; `bun run lint` exit 0, 4 warning preesistenti e 0 errori. E2E non eseguite sul Mac per regola del brief; P.1–P.4 vanno verificate in CI con «Clip di consegna».

## Fatto

- Aggiunta `tests/e2e/pane-store-two-devices.spec.ts` con P.1–P.4, topic creati per test, `hermetic(test)`, seed via `resetPaneStore`, chiusura utente via `closeTabViaX` e contesti distinti. P.1 asserisce la rimozione live su B: il percorso `ui-state:updated` applica `HYDRATE_FROM_SNAPSHOT` e il reducer elimina le pane tombstonate (`client/src/state/pane/middleware/syncWS.ts`, `client/src/state/pane/reducers/panes.ts`). E2E non eseguita localmente, quindi l'esito live è ancora da osservare nel video CI.
- P.2 controlla snapshot locale stantio, assenza di PUT di B dopo l'idratazione, reload di A e snapshot autorevole del server senza X.
- P.3 riapre X con ⇧⌘T e verifica che resti sul server dopo il reload di A.
- P.4 prepara un PUT nel debounce prima del drop del socket, chiude X mentre il server è giù e verifica il server e B dopo reconnect/reload. `downtimeMs: 4500`: 1.500 ms di countdown in `App.tsx:1484`, 500 ms di debounce e fino a 1.680 ms di retry con jitter in `syncServer.ts:25-27, 204`.
- Spec esclusa dal gate PR e assegnata al nightly con motivazione in `playwright.config.ts`; nessuna modifica alla produzione o a `tasks.md`.
- `./scripts/qa-gate.sh --veloce` exit 0: 0 check rossi (23 `check:*` elencati, più typecheck e lint del gate).

## Trovato e non fatto

- Le prove e2e e il video non sono stati eseguiti sul Mac, come vieta il brief. Serve la CI «Clip di consegna» per dichiarare P.1–P.4 verdi o registrare un difetto.
- **Mutazione P.2:** `client/src/state/pane/reducers/panes.ts:672`, sostituire `openedSeq > mark.seq` con il confronto tra `openedAt` e `closedAt` dei dispositivi. Il test deve diventare rosso perché B reintroduce/rimanda lo snapshot vecchio.
- **Mutazione P.4:** `client/src/state/pane/middleware/syncServer.ts:470-471`, rimuovere `armaSpinta()` sul lifecycle `open` quando `pendingAfterClose` è true. Il test deve diventare rosso perché il nuovo snapshot locale non viene ripresentato dopo il reconnect.

## Rifiutato

- Il possibile guasto live P.1 non è stato trattato come difetto già provato: il client applica gli aggiornamenti WS al reducer tombstone; la spec verifica il comportamento osservabile in CI.
