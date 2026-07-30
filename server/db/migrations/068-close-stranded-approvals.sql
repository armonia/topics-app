-- 068: chiude le richieste di approvazione appese a task che hanno già lasciato
-- la review.
--
-- `reviewDecision` era l'unico punto che risolveva una riga di `approvals`, ma
-- non è l'unica strada per uscire da `review`: il trascinamento sulla board,
-- `update({status})` da MCP e l'archiviazione portavano il task altrove
-- lasciando la riga 'pending' per sempre. Nessuno l'avrebbe più chiusa, perché
-- `reviewDecision` rifiuta un task che non è in review.
--
-- Misurato sul DB reale prima di scrivere questo file: 48 'pending' in tutto, di
-- cui 13 su task già usciti dalla review — 9 in 'done' e 4 in 'backlog'. Sono
-- quelle che il conteggio dei "pending in attesa" mostrava come lavoro da fare.
--
-- L'esito segue la stessa regola del codice (`server/services/tasks.ts`):
--   • task in 'done'  → 'approved': è esattamente ciò che l'approvazione chiedeva;
--   • ogni altro stato → 'expired': la domanda non ha più oggetto, e non è un
--     rifiuto — nessun umano ha detto no.
--
-- `reviewed_by = 'system'` distingue queste dalle decisioni vere di un umano.
-- `reviewed_at` NON si inventa: la data in cui il task ha cambiato stato è
-- `tasks.updated_at`, ed è la cosa più vicina al vero che esiste in tabella.
-- Le righe di task ANCORA in review non si toccano: quelle sono lavoro reale in
-- attesa.

UPDATE approvals
   SET status = 'approved',
       reviewed_by = 'system',
       reviewed_at = COALESCE(
         (SELECT t.completed_at FROM tasks t WHERE t.id = approvals.task_id),
         (SELECT t.updated_at FROM tasks t WHERE t.id = approvals.task_id)
       )
 WHERE status = 'pending'
   AND approval_type = 'review'
   AND task_id IN (SELECT id FROM tasks WHERE status = 'done');

UPDATE approvals
   SET status = 'expired',
       reviewed_by = 'system',
       reviewed_at = (SELECT t.updated_at FROM tasks t WHERE t.id = approvals.task_id)
 WHERE status = 'pending'
   AND approval_type = 'review'
   AND task_id IN (SELECT id FROM tasks WHERE status NOT IN ('review', 'done'));
