# D7c · Sleep e risveglio

**Barra prima:** 0 spec D7c; `typecheck:e2e` non eseguito; `typecheck` non eseguito; prova video assente.

**Barra dopo:** 2 casi `@nightly` aggiunti, ciascuno ferma il processo 60.000 ms; `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0. La spec e i video non sono stati eseguiti in locale: SCOPE riserva l'e2e alla CI «Clip di consegna».

## Fatto

- `tests/e2e/sleep-wake-recovery.spec.ts`: due scenari con turno da 90 chunk, uno con il server di test fermo e uno con l'ai-bridge fermo per 60 s. Dopo la ripresa verificano la sequenza completa senza duplicati o buchi, `performance.timeOrigin` invariato e i due ID pane identici nel DOM prima e dopo.
- `bun run typecheck:e2e` — exit 0.
- `bun run typecheck` — exit 0 (client, test client, server, e2e e relay).
- **Punto critico:** il recupero della chat aperta quando il socket si riapre (`client/src/hooks/useReconnectCatchUp.ts`, RUNTIME-20). Mutazione su una copia, ramo `daily/d7c-mutante`: `if (topic) void loadHistory(topic.sessionKey);` diventa `if (topic) void topic.sessionKey;`, e la clip di `tests/e2e/sleep-wake-recovery.spec.ts` gira sul ramo mutante. La prima proposta (cambiare il CLI finto del test) mutava la fixture, non il prodotto: scartata.

## Trovato e non fatto

- Esecuzione dei due scenari e acquisizione dei `.webm`: non girano sul Mac per regola dello SCOPE. Servono il workflow «Clip di consegna» con `tests/e2e/sleep-wake-recovery.spec.ts`; la barra runtime resta da provare in CI.

## Rifiutato

- Nessun difetto di produzione dedotto dalla sola lettura del codice: `useWebSocket` ha già il probe al ritorno di visibilità/focus e il backoff di riconnessione. La spec aggiunge la prova end-to-end senza introdurre fix non giustificati.
