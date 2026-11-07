# Barra di lossless-restart

## Comandi (escono non-zero se rotti)
- `bun test server/providers/native/turn-host.test.ts server/providers/native/detached-turn.test.ts server/lib/quiescence.test.ts server/lib/boot-partial-sweep.test.ts`
- `bunx tsc --noEmit -p .` e i cancelli `check:*` che la CI già gira.
- `bash scripts/test-e2e.sh tests/e2e/restart-loses-nothing.spec.ts` (sul PC: `pw-remote -- npx playwright test tests/e2e/restart-loses-nothing.spec.ts`), con video.

## Scenario e2e: `tests/e2e/restart-loses-nothing.spec.ts`
Il modello è il finto `tests/e2e/helpers/fake-anthropic-api.ts`, che vive nel processo di Playwright e quindi sopravvive al riavvio; consegna il testo a pezzi (un pezzo ogni 300 ms) e registra ogni giro che serve.

Con tre turni nativi in volo:
- **chat**: risposta lunga in streaming, almeno 8 pezzi già sullo schermo;
- **card**: card dispacciata su una board, turno a metà;
- **domanda**: `ask_user_question` col pannello aperto;

si riavvia il server (SIGTERM, come `restart-when-idle`). Poi, senza ricaricare la pagina e senza toccare Riprova:
- il server nuovo risponde a `/__daemon/healthz` entro **5 s** dal SIGTERM;
- la bolla della chat è la stessa riga (`messageId` uguale) e alla fine contiene tutti i pezzi, in ordine, una volta sola;
- il finto ha servito ogni giro (scenario, giro) **una volta sola**: niente rigenerato, niente ripagato;
- la card arriva in fondo sulla stessa sessione, senza tentativi consumati;
- il pannello della domanda è ancora lì; la risposta data DOPO il riavvio arriva al modello come `tool_result` dello stesso `tool_use_id`;
- nessun messaggio contiene «Turno interrotto» e nessun bottone Riprova è sullo schermo;
- il log di boot dice `partial sweep: reset 0`.

## Mutanti (ognuno deve far diventare rosso l'e2e o un test di unità)
- Punto critico: `NativeProvider.stop()` torna ad annullare i turni (`abort("server-shutdown")`) invece di staccarsi. Atteso rosso: giro della chat servito due volte, «Turno interrotto» presente.
- Il boot non riconosce gli id `native:` del broker come sessioni vive. Atteso rosso: `partial sweep: reset` > 0 e riga chiusa.
- Il processo staccato scrive solo il testo finale e non i delta. Atteso rosso: test di unità del diario (pezzi mancanti dopo il riattacco a metà).

## Ciò che è verde resta verde
- La suite unit e l'e2e della CI della PR.
- Con `TOPICS_NATIVE_DETACHED=0` il comportamento è quello di prima (stessi test del runtime nativo verdi).
