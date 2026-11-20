# Tracce

1. Proxy dei modelli e token per macchina. Barra: `model-proxy.test.ts`.
2. Hook `node-run` e cablaggio in `server.ts`. Barra: `lifecycle-hooks.test.ts`, `task-dispatcher-remote-node.test.ts`.
3. Identità del progetto (Mac e nodo), percorsi Windows, `no_such_repo`. Barra: `project-identity.test.ts`, `absolute-path.test.ts`, `nodes-routes.test.ts`.
4. Ponte MCP nel binario compilato. Barra: `topics-mcp-bridge-argv.test.ts` + prova di fumo del binario sul PC.
5. Predefinito di board e card specchiata locale. Barra: `tasks.board-dispatch-machine.test.ts`, `nodes-routes.test.ts`.
6. Lato PC (winfleet `nodo/`, `wf-autosleep`). Barra: scenario sul nodo vero.
