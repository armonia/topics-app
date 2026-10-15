# D1c · Frame di topic ai soli iscritti

**Bar prima:** `bun run measure:ws-idle -- --budget 256` → **479,2 B/s, exit 1** con il banco legacy (`hello` soltanto): `stream:usage` 14.836 B / 60 frame e `stream:content_chunk` 7.860 B / 60 frame; `external-sessions` 0.

**Bar dopo:** `bun run measure:ws-idle -- --budget 256` → **97,0 B/s, exit 0**; 0 frame della lista fissa alla finestra a riposo, 60 `stream:content_chunk` alla finestra che tiene il topic, 0 `external-sessions`. Riduzione misurata: 79,8%.

## Fatto

- Il banco invia `hello`, `presence:announce` vuoto e `subscribe` con `topicIds: []`, come l'app senza pane aperte.
  - Conta i frame di una lista fissa di tipi che un turno manda solo a chi tiene il topic. È scritta per esteso: il banco verifica `OUTBOUND_FRAME_CLASSES`, quindi non può prendere da lì la sua attesa.
  - Una seconda finestra iscritta al topic deve ricevere `stream:content_chunk`, così lo zero dell'altra finestra misura l'instradamento e non un turno muto.
  - Un turno finito in errore si riconosce dallo `stream:end` globale con `reason: "error"`, perché `stream:error` ora arriva solo a chi tiene il topic.
- Tutti i tipi di `REGISTERED_OUTBOUND_TYPES` hanno una classe esplicita (`global`, `topic`, `project`, `board`). Il test controlla copertura e le classi di `stream:usage`, `stream:context`, `stream:slow` e `stream:retry`.
- `broadcastToAll` manda i frame `topic` solo ai socket che tengono quel topic. Se manca `topicId`, risolve il topic dal `sessionKey` quando possibile.
  - Il frame passa dallo stesso ciclo di tutti gli altri, quindi per un ospite valgono ancora l'allowlist dei tipi, il controllo sull'entità e la rimozione di `mediaSizes`.
  - La prima versione instradava con `broadcastToTopicSubscribers`, che controlla solo `mayReadTopic`: un ospite iscritto riceveva `stream:usage`, `stream:tool_permission_required` e `message:media` con le misure dei file del proprietario. L'ha trovato la verifica indipendente.
  - Ora il test lo fissa (`server/guest-media-sizes.test.ts`): rosso sul codice di prima (+3 frame all'ospite), verde dopo. La sonda della verifica dà all'ospite gli stessi frame della base: `stream:content_chunk`, `stream:end`.
- `scripts:output` resta globale: serve sia la pane Processi sia il riepilogo del lavoro, e non identifica sempre un topic.
- Consumo:
  - `stream:usage` lo leggono `useChat` e `MessageParts`;
  - `stream:context` lo leggono `useRealContext`, `useCostProbe` e `MessageParts`;
  - `stream:slow`, `stream:retry` e `stream:resumed` li legge `MessageParts`;
  - contenuto, thinking, tool, errori e frame transitori del ciclo di vita li leggono i consumer della chat.
  - Restano globali `stream:start`, `stream:end`, `message:new`, `attention:updated` e `background:changed`, che tengono aggiornati stato della sidebar, anteprima, badge e notifiche.
- `tests/e2e/stream-topic-subscription.spec.ts`: una finestra, due topic con un turno ciascuno nello stesso momento.
  - Il topic aperto riceve `stream:content_chunk` e `stream:usage`, quello chiuso nessuno dei due.
  - A fine turno la riga del topic chiuso risulta `done`.
  - Le pane si sincronizzano fra dispositivi, quindi due finestre dello stesso progetto mostrano le stesse pane: «non iscritto» vuol dire non aperto in nessuna pane.
- `bun test tests/unit/ws-outbound-coverage.test.ts server/lib/ws-topic-routing.test.ts server/security-boundaries.test.ts server/lib/gateway-sse-consumer.test.ts server/routes/chat.wait-on-registry.test.ts server/guest-media-sizes.test.ts` → **41 pass, 0 fail, exit 0**.
- `bun run typecheck` → **exit 0**, `typecheck:e2e` compreso.
- Mutazione in copia: `stream:usage` riclassificato globale. `measure:ws-idle -- --budget 100000` → **exit 1** per i soli frame: 60 frame della lista, attesi 0, con 344,3 B/s sotto il tetto.

## Trovato e non fatto

- Su `main`, una chat senza tab non ha riga nella sidebar finché il suo turno è in corso. La riga arriva solo con il risultato. Provato con la stessa spec su `main` senza D1c (run 38660549867): stesso esito. Non dipende da D1c, ed è fuori da questa traccia.

## Rifiutato

- I 479,2 B/s iniziali erano un artefatto del banco legacy, che non dichiarava gli abbonamenti dell'app. `ui-state:init` resta fuori: costa alla riconnessione, non a riposo.
