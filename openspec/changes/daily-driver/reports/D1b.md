# D1b · Rimozione del frame senza lettori

**Bar prima:** `bun run measure:ws-idle -- --budget 1024` → **2.140,8 B/s, exit 1**, 3 frame `external-sessions`; la baseline D0 era **2.147,5 B/s, exit 1**.

**Bar dopo:** stesso comando, tre run da 60 s → **478,9 / 472,6 / 479,2 B/s, exit 0**. Ogni run ha verificato **100 sessioni, 12 attive e 0 frame `external-sessions`**.

## Fatto

- `server/services/external-sessions.ts` non trasmette più né forza scansioni ogni 20 s. `activeAt`, route e conteggi usano la stessa cache TTL; `server.ts` conserva guardia dispatcher, route e due conteggi.
- Rimosso schema e tipo `external-sessions` dal registro (`shared/ws-outbound.ts`, test di protocollo e dichiarazione dei non consumati). La copertura dei broadcast senza schema resta verde.
- Aggiornato `scripts/measure-ws-idle.ts`: verifica il censimento HTTP di 100 sessioni, 12 attive, e richiede zero frame durante il carico invariato. `FLIPS_PER_TICK`, turno e budget restano invariati.
- Mutazione in `/private/tmp/topics-d1b-mut-copy`, con il broadcast ripristinato: misura **2.147,2 B/s, 3 frame, exit 1**. La barra rileva di nuovo il carico oltre budget.
- Test mirati `bun test server/services/external-sessions.test.ts tests/unit/ws-outbound-schema.test.ts tests/unit/ws-outbound-coverage.test.ts` → **94 pass, 0 fail, exit 0**. `bun run typecheck` → exit **0**, cinque verifiche verdi. `bun run lint` → exit **0**, quattro warning React in file client non toccati. `git diff --check` → exit **0**.

## Trovato e non fatto

- `tests/e2e/external-sessions.spec.ts` già verifica il censimento via `/api/external-sessions` e non dipende dal frame. E2E non eseguita sul Mac per il divieto del brief locale; resta alla CI dopo il push del proprietario.

## Rifiutato

- Nessuna modifica UI: il chip che leggeva il frame era già stato rimosso il 13/08. Il censimento resta utile a route HTTP, dispatcher e presenza.
