# Tracce

1. **Adattatore API sessioni** (`server/providers/claude-cloud/{api,events,session,creds}.ts`).
   Barra: `bun test server/providers/claude-cloud/claude-cloud.test.ts`.
2. **Nodo cloud nella corsia remota** (`node.ts`, `server.ts`: macchina «Cloud Claude»,
   instradamento delle quattro chiamate, heartbeat della riga). Barra: `node.test.ts` + spec e2e.
3. **Provider chat `claude-cloud`** (`provider.ts`, registro in `providers/index.ts`).
   Barra: `bun run typecheck:server`.
4. **Scenario e2e con video** (`tests/e2e/board-cloud-card.spec.ts`, finto
   `helpers/fake-claude-cloud.ts`, rotta `POST /api/test/claude-cloud`). Barra: lo spec, verde.
5. **Checkout della board per la corsia remota**: l'id della board è un hash del percorso,
   non l'id del project store. L'e2e lo ha trovato rosso il 26/10; nel frattempo `main` lo ha
   corretto con `projectPathOfAnyId`, che il nodo cloud usa. Barra: lo spec e2e.
