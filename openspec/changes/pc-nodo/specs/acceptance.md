# Barra di pc-nodo

## Comandi (escono non-zero se rotti)
- `bun test server/services/model-proxy.test.ts server/services/task-dispatcher-remote-node.test.ts server/services/lifecycle-hooks.test.ts server/services/node-branch-plant.test.ts server/lib/absolute-path.test.ts server/lib/project-identity.test.ts server/lib/topics-mcp-bridge-argv.test.ts server/routes/tasks.board-dispatch-machine.test.ts`
- `TOPICS_TEST_TIMEOUT_MS=300000 bun test tests/integration/nodes-routes.test.ts`
- CI della PR verde (typecheck, rails, unit, lingua dei commenti, em-dash).

## Scenario sul nodo vero (prova del 26/10)
- Una card con `machine_id` = PC arriva in review con il ramo piantato nel checkout del Mac.
- Durante la corsa i processi `claude` sono figli del `topics-server.exe` del PC; il coordinatore del Mac non ha figli.
- Il log del proxy del Mac mostra le chiamate `machine=<PC> status=200`.
- Alla fine sul PC nessun file con credenziali di Claude fuori dal Cestino.
- Video della card che passa dal PC.

## Mutanti (ognuno deve far diventare rosso almeno un test)
- Proxy: qualunque token accettato.
- Hook: veto ignorato.
- Card del nodo con l'UUID dello store al posto dell'id della board.
- Ponte MCP: sempre `run <script>` anche nel binario compilato.
- Card specchiata senza `machineId: null`.
- `wf-autosleep`: senza il segnale «topics nodo» il motivo sparisce con una card in corso.
