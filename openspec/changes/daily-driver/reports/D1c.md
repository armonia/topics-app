# D1c · Frame di topic ai soli iscritti

**Bar prima:** `bun run measure:ws-idle -- --budget 256` → **479,2 B/s, exit 1** con il banco legacy (`hello` soltanto): `stream:usage` 14.836 B / 60 frame e `stream:content_chunk` 7.860 B / 60 frame; `external-sessions` 0.

**Bar dopo:** tre `bun run measure:ws-idle -- --budget 256` → **97,0 B/s, exit 0** ciascuno; **0 frame topic** e 0 `external-sessions`. Riduzione misurata: 79,8%.

## Fatto

- Il banco invia `hello`, `presence:announce` vuoto e `subscribe` con `topicIds: []`, come l'app senza pane aperte. Distingue i frame per classe e fallisce se ne riceve uno `topic`.
- Tutti i tipi di `REGISTERED_OUTBOUND_TYPES` hanno una classe esplicita (`global`, `topic`, `project`, `board`). Il test controlla copertura e le classi di `stream:usage`, `stream:context`, `stream:slow` e `stream:retry`.
- `broadcastToAll` instrada i frame `topic` tramite gli iscritti. Se manca `topicId`, risolve il topic dal `sessionKey` quando possibile. `scripts:output` resta globale: serve sia la pane Processi sia il riepilogo del lavoro e non identifica sempre un topic.
- Consumo: `stream:usage` è letto da `useChat` e `MessageParts`; `stream:context` da `useRealContext`, `useCostProbe` e `MessageParts`; `stream:slow`/`retry`/`resumed` da `MessageParts`; contenuto, thinking, tool, errori e lifecycle transitori dai consumer della chat. Una finestra senza il topic non mostra questi dettagli. Restano globali `stream:start`, `stream:end`, `message:new`, `attention:updated` e `background:changed`, che mantengono stato sidebar, anteprima, badge e notifiche.
- Aggiunto `tests/e2e/stream-topic-subscription.spec.ts`: due finestre, una sola iscritta, contatori WebSocket su `stream:usage` e `stream:content_chunk`, stato sidebar prima/dopo e video per entrambe.
- `bun test tests/unit/ws-outbound-coverage.test.ts server/lib/ws-topic-routing.test.ts server/security-boundaries.test.ts server/lib/gateway-sse-consumer.test.ts server/routes/chat.wait-on-registry.test.ts` → **39 pass, 0 fail, exit 0**.
- `bun run typecheck` → **exit 0**, inclusi `typecheck:e2e`; `git diff --check` → **exit 0**.
- Mutazione in copia: `stream:usage` riclassificato globale (equivalente a tornare al broadcast a tutti); `measure:ws-idle -- --budget 256` → **344,3 B/s, exit 1**, 60 frame `stream:usage`.

## Trovato e non fatto

- La spec e2e non è stata eseguita sul Mac: `BRIEF-locale.md` vieta le e2e Chromium locali. `typecheck:e2e` è verde; la prova video attende la CI.

## Rifiutato

- I 479,2 B/s iniziali erano un artefatto del banco legacy, che non dichiarava gli abbonamenti dell'app. `ui-state:init` resta fuori: costa alla riconnessione, non a riposo.
