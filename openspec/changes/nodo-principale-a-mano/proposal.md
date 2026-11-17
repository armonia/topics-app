## Da decidere

1. **Strada: «il nodo regge senza il Mac» (consigliata), non lo spostamento completo.** Dà il risultato che hai chiesto (card che continuano e finiscono a Mac spento, la consegna ti aspetta al ritorno) in circa 24 h di lavoro, senza toccare DB, board, tunnel né hub degli account. Lo spostamento completo costa circa 100 h, resta comunque a metà (il 45% dei lavori ha bisogno del filesystem del Mac, vedi `sottoagenti-nodo`) e porta un rischio di doppio principale. Alternativa: completo, solo se ti serve assegnare card nuove o guardare la board dal telefono a Mac spento.
2. **Un login Claude sul nodo (token di un anno, solo per il nodo, revocabile) come ripiego quando il proxy del Mac non c'è.** Senza, a Mac spento ogni turno sul nodo fallisce e il nodo non può lavorare. Cambia la regola «i nodi non hanno login», e la quota dell'abbonamento verrebbe usata da un IP di datacenter: che Anthropic lo tolleri non l'ho verificato (prima traccia M2 lo prova con un turno vero). Alternativa: nessun login, e allora «lavoro che continua col Mac spento» non si può avere.
3. **Il menù «Nodo principale» nella tray arriva solo con la strada completa.** Con la minima il principale resta sempre il Mac e non c'è nulla da scegliere; la tray mostra solo, per ogni card, «il Mac era spento, ha continuato il nodo». Se il menù lo vuoi comunque, la scelta 1 diventa «completa».

«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

# Il nodo continua a lavorare quando il Mac è spento

**Perché.** Oggi una card su un nodo vive finché vive il Mac: il modello passa dal proxy del Mac (tunnel `-R`, `deploy/cloud-node/node-pool:27-28`) e, se il Mac riparte, la corsa viene cancellata e rifatta da zero (`task-dispatcher-remote-node.ts:525`, `routes/nodes.ts:617-622`). Un lavoro finito sul nodo mentre il Mac dormiva viene archiviato come «copia vecchia» e perso per la card. Risposte con file:riga in `analisi.md`.

**Cosa cambia (strada minima, 4 tracce, `tasks.md`).**
- Riattacco: al riavvio del Mac una card con corsa aperta sul nodo rilegge quella corsa invece di cancellarla; se è finita, consegna il ramo; se il nodo non risponde, aspetta (non la rimette in coda).
- Modello senza Mac: il Topics del nodo apre un proxy suo (stesso codice `model-proxy.ts`), che prova prima il Mac via tunnel e, se non c'è, usa il login del nodo.
- Il Mac che torna: tunnel riaperti da `node-pool giro` (già lo fa), commenti scritti sul nodo nel frattempo riportati sulla card.
- Prova vera: nodo permanente, Mac fermo 10 minuti e 8 ore simulate, consegna riportata.

**Barra.** Test della corsia con nodo finto (riattacco, nodo muto, corsa sparita) · test del proxy a due monti · scenario reale con video: server del Mac fermo a metà turno, la card finisce sul nodo, al riavvio la consegna arriva senza `createRun`. `openspec validate nodo-principale-a-mano` esce 0.

**Fuori.** Spostare board, DB (`data/topics.db`, Litestream) e hub degli account sul nodo; assegnare card nuove a Mac spento; PC Windows come principale (dorme, ha la sua gestione in winfleet); qualunque nome o IP nel codice (tutto da `machines` e impostazioni).

**Spostamento completo (confronto, 7 tracce F1-F7 in `tasks.md`).** Principale = chi ha il DB e il dispatcher; un numero di epoca respinge chi ha un principale vecchio; passaggio pulito: drain, `.backup` del DB, copia con token dei nodi e cartella di stato, avvio sul nodo, epoca+1; il Mac torna come nodo (tunnel `-R` aperto da lui, perché non è raggiungibile da fuori). Se il principale scelto tace, la tray lo dice e offre «prendi tu» a mano: mai automatico. Stato dell'arte: Litestream replica in modo asincrono con finestra di perdita piccola e non fa failover da solo, LiteFS lo fa con un lease, rqlite con Raft ([litestream.io/alternatives](https://litestream.io/alternatives/)): per un solo utente con un solo scrittore il failover a mano con epoca è la scelta proporzionata.

**Costi.** Minima ≈ 24 h, spesa nuova 0 € (il nodo permanente c'è già; il modello usa la stessa quota). Completa ≈ 100 h, spesa 0 € ma l'hub degli account (fuori da questo repo) va portato o duplicato.

## Non ancora specificato

- Se Anthropic tollera lo stesso abbonamento da un IP di datacenter (da provare con un turno vero, poi decide la decisione 2).
- Dove vive la scelta del principale quando il Mac e il nodo non si parlano (solo strada completa).
- Come la app sul Mac si collega a un server remoto invece del suo (solo strada completa).
