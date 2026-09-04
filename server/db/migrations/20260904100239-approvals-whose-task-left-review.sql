-- 20260904100239-approvals-whose-task-left-review.sql
--
-- LA CARD DICEVA «21 APPROVAZIONI IN ATTESA», LE ATTESE VERE ERANO ZERO.
--
-- La 068 aveva già bonificato lo stock di allora, ma con due maglie larghe:
-- guardava solo `approval_type = 'review'` e non conosceva l'archiviazione. Un
-- task in review ARCHIVIATO non è in nessuna coda che qualcuno guardi, e la sua
-- riga restava 'pending' per sempre; lo stesso per una richiesta di tipo
-- 'completion' o 'status_change' il cui task è andato avanti.
--
-- Misurato su `data/topics.db` prima di scrivere questo file: 21 'pending', di
-- cui 14 su task 'done', 6 su task in review ma archiviati e 1 su un backlog
-- archiviato — la più vecchia del 2026-07-12. Con il join sul task davvero in
-- review e non archiviato: 0. Il conto sulla sola tabella `approvals` non è una
-- lettura imprecisa, è un marchio rosso permanente su cui non si può nemmeno
-- agire: nel client non esiste nessuna UI per elencare o chiudere queste righe,
-- l'unica porta è muovere il task.
--
-- Il rimedio per il FUTURO sta nella query del cruscotto, che ora passa dal task
-- (`server/routes/dashboard.ts`); questa migration è per le righe già scritte,
-- che quella query filtrerebbe soltanto lasciandole appese in tabella.
--
-- L'esito segue la regola già scritta nel codice (`settleReviewApproval`) e
-- nella 068: 'done' → 'approved', perché è ciò che l'approvazione chiedeva;
-- ogni altra destinazione → 'expired', perché la domanda non ha più oggetto e
-- nessun umano ha detto no. `reviewed_by = 'system'` distingue queste dalle
-- decisioni vere; `reviewed_at` non si inventa, è la data in cui il task si è
-- mosso. Le righe di task ANCORA in review e non archiviati non si toccano:
-- quelle sono lavoro reale in attesa.

UPDATE approvals
   SET status = 'approved',
       reviewed_by = 'system',
       reviewed_at = COALESCE(
         (SELECT t.completed_at FROM tasks t WHERE t.id = approvals.task_id),
         (SELECT t.updated_at FROM tasks t WHERE t.id = approvals.task_id)
       )
 WHERE status = 'pending'
   AND task_id IN (SELECT id FROM tasks WHERE status = 'done');

UPDATE approvals
   SET status = 'expired',
       reviewed_by = 'system',
       reviewed_at = (SELECT t.updated_at FROM tasks t WHERE t.id = approvals.task_id)
 WHERE status = 'pending'
   AND task_id IN (
         SELECT id FROM tasks
          WHERE status <> 'done'
            AND (status <> 'review' OR archived = 1)
       );
