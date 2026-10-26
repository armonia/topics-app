## Da decidere

1. Fondere la PR di `feat/pc-nodo` a CI verde. Perché: la corsa remota è provata su un nodo vero, e tutto resta spento finché `TOPICS_MODEL_PROXY_PORT` non è impostata e una card non nomina un nodo (o: tenerla aperta finché il PC non gira una release ufficiale).
2. Una release subito dopo il merge. Perché: la 2.3.30 per Windows ha il ponte MCP rotto, e oggi il PC gira una build compilata dal ramo (o: aspettare il prossimo giro di release).
3. Accendere il nodo sulla Topics viva: porta del proxy, tunnel in launchd, predefinito PC sulle board idonee (winfleet sì, la board personale no, topics-app non finché ha rossi su Windows). Perché: è il passo che sposta davvero il carico dal Mac (o: solo card mandate a mano al PC).

«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

# Il PC come seconda macchina di Topics

**Perché.** Il Mac (32 GB, load 35-50) soffre; il PC (20 core, 32 GB) sta fermo. La corsa remota dei nodi (KANBAN-76/77) esisteva ma non era mai girata su un nodo vero, e il modello doveva passare dalla Topics del Mac: niente login di Claude sul PC.

**Cosa cambia (ramo `feat/pc-nodo`).**
- Proxy dei modelli sul Mac: porta dedicata su 127.0.0.1, solo `/v1/messages` e `count_tokens`, token per macchina (solo l'hash su disco), inoltro con le credenziali del Mac.
- Hook `node-run` prima della corsa: sveglia il PC, porta il repo con un git bundle, registra il progetto. Veto = la card resta in coda.
- Correzioni trovate sulla corsa vera: id della board contro id dello store (lato Mac e lato nodo), percorsi Windows assoluti, `no_such_repo` con `code`, fetch di origin se manca la base, token modello per il proprietario anche da loopback, ponte MCP nel binario compilato (`--topics-mcp-bridge`), card specchiata con `machineId` nullo.
- Board: computer di esecuzione predefinito (`dispatch_machine_id`).
- Fuori dal repo (winfleet `nodo/`): installazione, server headless da task pianificato, tunnel `-L`/`-R`, `pc-nodo-prep`; `wf-autosleep` conta le card del nodo come lavoro.

**Barra.** `specs/acceptance.md`.

**Fuori.** Il pavimento di memoria del dispatcher (`task-dispatcher.ts:5172`, del Direttore Topics: qui solo il test di contratto sul ramo `test/contratto-nodo-pavimento`). Firewall e impostazioni di sicurezza di Windows. Token GitHub sul PC.

**Deciso da me.** Il nodo raggiunge il Mac solo sulla porta del proxy (mai la principale: da loopback vale proprietario). Il Mac raggiunge il nodo sulla porta tunnel (remota, appaiamento obbligatorio). Il modello del CLI passa dal blocco `env` di `~/.claude/settings.json` del PC, che vince sull'ambiente perché Topics lancia il CLI con `--setting-sources user`.

## Non ancora specificato

- Cosa fa il nodo quando una persona usa il PC (gioco, GPU al 95% la notte del 26/10): oggi la card parte comunque.
- Più di un nodo per board, e chi sceglie fra loro.
