# Tasks — subagent-nativi

- [x] 1. Migrazione `20261004180000-subagents-native-runtime.sql` (`runtime`, `session_key`, `tools`) e store (`getSubagentBySessionKey`, `subagentDepth`, `resumeVerdict` senza transcript per i nativi)
- [x] 2. `subagent-tool-policy.ts`: `MAX_AGENT_DEPTH = 2`, traduzione di `tools:`, politica per sessione
- [x] 3. `native-subagents.ts`: spawn, turno, esito, send, stop, Stop del padre, read, adozione al boot
- [x] 4. Route `/api/sessions/:key/agents/*`: runtime di default, ricaduta dichiarata, list/send/read/stop dei nativi
- [x] 5. Provider nativo: strumenti filtrati per profilo e profondità, rifiuto all'esecuzione (`allowTool`)
- [x] 6. `/api/chat/abort`: lo Stop di una persona ferma i figli nativi al lavoro
- [x] 7. `server.ts`: configurazione e adozione al boot
- [x] 8. Schema MCP di `spawn_agent`: `runtime`, descrizione
- [x] 9. Test: `server/lib/native-subagents.test.ts`, `tests/integration/subagent-native.test.ts`
- [ ] 10. Prova dal vivo sul server di produzione (dopo il merge)
- [ ] 11. Client: i figli nativi nella striscia dei sotto-agenti al lavoro
