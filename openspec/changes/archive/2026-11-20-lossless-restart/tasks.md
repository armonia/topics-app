# Tracce

1. **Processo del turno** (`server/providers/native/turn-host.ts`): legge la specifica del turno da stdin, gira `runAgentTurn`, scrive il diario degli eventi su stdout, ascolta `abort` su stdin. Barra: `turn-host.test.ts`.
2. **Cliente del processo** (`server/providers/native/detached-turn.ts` + `provider.ts`): avvio via broker, traduzione del diario in `StreamHandler`, `stop()` = stacca, `reattach`, `isTurnProcessAlive`, `ownsSession`, `hasLiveSession`, `brokerTurnState`. Barra: `detached-turn.test.ts`. Dipende da 1.
3. **Server** (`server.ts`, `task-dispatcher`, `routes/chat.ts`, `quiescence.ts`, `boot-partial-sweep.ts`): gli id `native:` contano come sessioni vive al boot, la riadozione e il ramo `live` del dispatcher chiedono al provider giusto, le card su un provider che riadotta non trattengono il riavvio, i parziali orfani si chiudono. Barra: test di unità toccati + e2e. Dipende da 2.
4. **MCP e domande**: chiamate MCP della flotta dal processo staccato via `/api/native/mcp-call`; la richiesta di risposta a `ask_user_question` riprova finché il server torna. Barra: e2e (domanda). Dipende da 2.
5. **E2E** (`tests/e2e/restart-loses-nothing.spec.ts` + finto a pezzi). Barra: è la barra. Dipende da 3 e 4.
6. **Script** (`~/.claude/jarvis/scripts/topics-riavvio-a-zero-turni`, `topics-riavvio-unico`, `topics-pubblica-client`): niente più attesa della finestra a zero turni; aspettano solo ciò che il server dichiara non riadottabile. Barra: `bash -n` + prova a secco (`DRY=1`).
