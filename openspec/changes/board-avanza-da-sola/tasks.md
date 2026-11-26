# Tracce

Una traccia per regola. Lo stato lo dice git (un commit per traccia) e il test, non la casella.

## T1 Auto-land, solo la domanda di una persona ferma
- **C'era già**: `server/services/auto-land.ts` atterra da solo quando la verifica è pulita; una domanda aperta bloccava ogni consegna.
- **Mancava**: distinguere la domanda che spetta a una persona da quella di sola approvazione.
- **Toccati**: `shared/workflow.ts` (`askNeedsPerson`), `server/services/auto-land.ts`, `server/services/auto-land.test.ts`.
- **Barra**: `bun test ./server/services/auto-land.test.ts`. Già committata prima (928015d81a). Mutazione suggerita: far rispondere `askNeedsPerson` sempre `true`, il test sulla domanda di sola approvazione deve diventare rosso; non rifatta in questa tornata.

## T2 Card visibile senza foto
- **C'era già**: `server/services/tasks/delivery.ts` consegna in review con l'anteprima; senza foto la card restava ferma.
- **Mancava**: instradarla su questa macchina e tenerla in todo.
- **Toccati**: `server/services/tasks/delivery.ts`, `server/services/tasks.system-delivery.test.ts`.
- **Barra**: `bun test ./server/services/tasks.system-delivery.test.ts`. Già committata prima (928015d81a). Mutazione suggerita: tornare al backlog, il test sulla colonna deve diventare rosso; non rifatta in questa tornata.

## T3 Niente doppioni
- **C'era già**: 409 `duplicate` per somiglianza (`findDuplicates`) su due rotte di creazione (sessione agente e coordinatore), con due copie del blocco.
- **Mancava**: assorbire la richiesta ripetuta di una card aperta; un punto solo per le due rotte.
- **Toccati**: `server/services/card-dedupe.ts` (nuovo, helper condiviso), `findOpenTwin` in `server/services/tasks.ts` e `tasks-service-types.ts`, `server/routes/tasks.ts`, `server/routes/tasks.dedupe.test.ts`.
- **Comportamento**: titolo normalizzato uguale o stessa chiave di idempotenza di una card non done e non archiviata della stessa board: 200 `{...card, deduped:true}`, commento di servizio (`once`) col titolo e la descrizione ripetuti. Card done o archiviata: nessun assorbimento, vale il comportamento di prima. `allow_duplicate` salta il cancello.
- **Barra**: `bun test ./server/routes/tasks.dedupe.test.ts`. Mutazione: disattivare il ramo `absorbed` nell'helper, quattro test rossi.

## T4 Sblocco
- **C'era già**: sweep per attese oltre il tetto (`sweepWaitedOut`), rientro delle card ferme dalla macchina (`sweepMachineWaitedOut`), il reconcile ogni 10 s. Nessuno scriveva il motivo di una card ferma senza motivo.
- **Mancava**: nota col motivo calcolato e rimessa in coda se la macchina assegnata è giù.
- **Toccati**: `server/services/stuck-card.ts` (nuovo: `diagnoseStuckCard` pura, `sweepStuckCards`), aggancio in `server/services/task-dispatcher-reconcile.ts` (al massimo una volta ogni 5 minuti), `server/services/stuck-card.test.ts`.
- **Comportamento**: soglia `STUCK_AFTER_MS` = 60 min. Nessun intervento se c'è già `dispatchError`, `waitReason`, stato `waiting`/`parked` o una ragione di coda che spiega (tetto di spesa, finestra del piano, ecc.), o se un turno vivo possiede la card. Una nota per card (marcatore nel testo).
- **Barra**: `bun test ./server/services/stuck-card.test.ts`. Mutazioni: togliere il controllo del marcatore (rosso: una nota per card), togliere il ramo macchina giù (rosso: rimessa in coda).

## T5 Giri a vuoto
- **C'era già**: il budget di tentativi (`dispatch_attempts` contro `dispatchRetryCap`), azzerato dal progresso reale; a budget finito il tick parcheggiava la card in backlog col chip `failed`.
- **Mancava**: restare visibile. In backlog nessuno guarda.
- **Toccati**: `release({ keepInTodo })` in `server/services/tasks/status.ts` e `tasks-service-types.ts`, `server/services/task-dispatcher-tick.ts` (usa `keepInTodo`, non riparcheggia una card già `failed`, testo «N tentativi senza esito»), `server/services/task-dispatcher.test.ts`.
- **Barra**: `bun test ./server/services/task-dispatcher.test.ts -t "giri a vuoto"` e `-t "budget finito"`. Mutazione: togliere `keepInTodo: true` dal tick, il test rosso.

## T6 Decisioni nel canale giusto
- **C'era già**: la chat che ha aperto la card (`origin_topic_id`, canale incluso) viene svegliata all'esito review/done/failed (`server/services/card-outcome-wake.ts`); `confirmCardOrigin` conferma la nascita.
- **Mancava**: il risveglio non portava la domanda (`humanAsk`), solo «è in review».
- **Toccati**: `server/services/card-outcome-wake.ts` (campo `humanAsk` nel frame, riga «Question for the person…», troncata a 600 caratteri e senza poter chiudere il tag), `server/services/card-outcome-wake.test.ts`.
- **Barra**: `bun test ./server/services/card-outcome-wake.test.ts`. Mutazione: spegnere la riga della domanda, il test sul canale rosso.

## T7 Riavvii
- **C'era già, nessun codice nuovo**: un land che tocca il server (`touchesServer` in `auto-land.ts`) aspetta zero turni vivi (`liveTurns`), poi il watcher del server riavvia sul merge; il riavvio rinviato (`/__daemon/restart-when-idle`) è tenuto da `server/lib/quiescence.ts` finché ci sono turni.
- **Barra**: `bun test ./server/services/auto-land.test.ts ./server/lib/quiescence.test.ts` (verde = la regola regge). Nessuna mutazione: non c'è codice aggiunto.
