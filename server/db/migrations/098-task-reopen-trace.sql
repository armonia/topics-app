-- 098-task-reopen-trace.sql: una card che ESCE da `done` lascia un segno sulla
-- card stessa, e chi l'aveva chiusa resta scritto.
--
-- Il numero è 098 e non 097 perché la 097 è già rivendicata da DUE card in volo
-- (`097-task-plan-comment.sql`, `097-discord-presence.sql`): main è ferma alla
-- 096, quindi il cancello (`scripts/check-migration-numbers.ts`) le vede libere
-- entrambe finché una non atterra. Saltare avanti costa un buco nella
-- numerazione — che al runner non dice niente, visto che `schema_migrations` è
-- indicizzato per NOME — e toglie una collisione certa al land. Vedi
-- l'intestazione di `090-task-dispatch-weight.sql`: con N card in parallelo due
-- migration scritte lo stesso giorno che prendono lo stesso numero non sono
-- sfortuna, sono l'esito normale.
--
-- Misurato l'11/08: in sei ore ELEVEN card sono uscite da `done` (quasi tutte
-- per mano di agenti: il padre che rifà un sottotask, l'agente che si corregge
-- dopo aver letto un UAT rosso). Nessuna si è persa — ma la board non lo diceva:
-- il motivo viveva nel thread della card, e chi guardava la colonna vedeva solo
-- un buco dove c'era una cosa fatta. Done è la colonna su cui ci si fida.
--
-- Due colonne, due domande diverse:
--   · done_actor   — CHI ha chiuso ('human' | 'agent' | 'system'). È il cardine
--                    del cancello: un `done` deciso da un umano (approvazione in
--                    review o trascinamento sulla board) non lo riapre un agente;
--                    il proprio step di checklist, chiuso dall'agente stesso
--                    ('agent') e mai passato da una review, resta riapribile.
--   · reopened_*   — la TRACCIA: quando, per mano di chi (nome) e con che ruolo
--                    la card è uscita da `done`. Vive finché la card non torna
--                    `done` (allora il ciclo è chiuso e il segno si azzera).
-- Entrambe escono dall'API della board (Task.doneActor / reopenedAt / reopenedBy
-- / reopenedActor), quindi il segno è leggibile senza scavare nei commenti.
ALTER TABLE tasks ADD COLUMN done_actor TEXT;
ALTER TABLE tasks ADD COLUMN reopened_at TEXT;
ALTER TABLE tasks ADD COLUMN reopened_by TEXT;
ALTER TABLE tasks ADD COLUMN reopened_actor TEXT;

-- Backfill: le card già `done` che portano un'approvazione di review APPROVATA
-- sono chiusure umane — è l'unica prova certa che esista per lo storico (1114
-- card done al momento della migration). Le altre restano NULL = "non si sa",
-- e il cancello le tratta come riapribili: murare a posteriori lo storico
-- bloccherebbe proprio i sottotask che gli agenti chiudono da soli.
UPDATE tasks
   SET done_actor = 'human'
 WHERE status = 'done'
   AND EXISTS (
     SELECT 1 FROM approvals a
      WHERE a.task_id = tasks.id
        AND a.approval_type = 'review'
        AND a.status = 'approved'
   );
