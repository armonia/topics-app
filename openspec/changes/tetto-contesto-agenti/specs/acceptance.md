# Barra eseguibile

| Cosa | Comando (esce non-zero se non regge) |
|---|---|
| Decisione pura con e senza tetto, simulazione di 200 giri su 1M | `bun test ./server/providers/native/compaction-cap.test.ts` |
| Filo provider → turno e provider → `TurnSpec`; a metà turno nessun taglio | `bun test ./server/providers/native/compaction-cap-turn.test.ts` |
| Filo dentro il `turn-host` vero (demone e processo veri, API finta) | `bun test ./server/providers/native/detached-turn.test.ts -t "ceiling"` |
| La route segna le continuazioni (ripresa, nudge del goal e degli hook), non il composer né il messaggio Discord di jarvis-channels | `bun test ./server/routes/chat.continuation-turn.test.ts` |
| Lettura di `agent-engine.json` | `bun test ./server/lib/agent-engine-settings.test.ts` |
| Misura su chat vere (sola lettura su log e DB) | `bun scripts/token-audit.ts --since <da> --until <a> --project ~/.topics/agents/jarvis --project ~/.topics/agents/gtm --calls` |

## Scenari
- Senza tetto, 300k su 1M: niente compattazione. Con tetto 200k: compatta sotto 94k, la richiesta iniziale resta.
- Tetto sopra la soglia della finestra (200k su 200k; 900k su 1M; 800k su 1M non calibrato): nulla cambia.
- Tetto 0, negativo, NaN, infinito, stringa: nessun tetto.
- 200 giri da 4k su 1M: senza tetto 0 compattazioni e oltre 780k; con 200k nessuna chiamata oltre 204k, media sotto la metà, al massimo 10 compattazioni.
- Stesso traffico su una chat d'agente e su una chat qualunque: compatta solo la prima; solo il suo `TurnSpec` porta `compactAtTokens`.
- Stesso traffico sulla chat d'agente in turni di continuazione: nessuna compattazione, e il `TurnSpec` senza `compactAtTokens`.
- Il corpo esatto di jarvis-channels (`dispatched`, `clientMessageId`, `sender`) non è una continuazione.
- Turno di cinque giri da 40k caratteri su una chat oltre il tetto: una compattazione sola, la richiesta in tutte e sei le chiamate.
- Un risultato fresco da 40k caratteri nella coda resta intero quando scatta il tetto.
- Due compattazioni di fila lasciano identici gli argomenti già alleggeriti («4800 chars dropped»).

## Mutazioni (verificate a mano il 27/11)
Tolto il tetto in `compactionThresholds`, tolto da `turnOpts`, tolto dal `TurnSpec`, non passato da `agent-loop` a `compactIfNeeded`, non letto in `turn-host`, tetto applicato a ogni giro, taglio dei risultati misurato contro il tetto, alleggerimento non idempotente, tetto dato anche alle continuazioni, `continuation` non messo dalla route, continuazione letta come `!sentByPerson`: in tutti e undici i casi il test corrispondente è rosso; ripristinato, verde.
