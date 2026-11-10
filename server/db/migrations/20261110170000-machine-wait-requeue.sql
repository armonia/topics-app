-- 20261110170000-machine-wait-requeue.sql
--
-- Una card parcheggiata `waited_out` per una ragione di MACCHINA (nodo muto,
-- PC che non si sveglia) restava in backlog per sempre: la condizione di
-- solito torna da sola, ma nessuno la rimetteva in coda (10/11: «chi gestisce
-- le card in backlog?»). Due colonne:
--   · `wait_source`   → chi ha dichiarato l'attesa ('agent' | 'machine').
--     Solo le attese di macchina rientrano da sole: quella di un agente
--     aspetta qualcosa che l'agente stesso ha nominato, e decide l'umano.
--   · `auto_requeues` → quante volte il dispatcher l'ha già rimessa in todo
--     da sola. Il tetto ferma il giro infinito; lo azzera un gesto umano.
ALTER TABLE tasks ADD COLUMN wait_source TEXT;
ALTER TABLE tasks ADD COLUMN auto_requeues INTEGER NOT NULL DEFAULT 0;
-- Le card già parcheggiate da un nodo prima di questa colonna: la frase è
-- quella di task-dispatcher-remote-node.ts.
UPDATE tasks SET wait_source = 'machine'
 WHERE dispatch_state = 'waited_out' AND wait_reason LIKE 'il nodo «%';
