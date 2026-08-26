-- Il badge di non-letto non sopravvive all'archiviazione.
--
-- `archiveTopicFully` azzera già il conteggio, e tutti e tre i percorsi di
-- archiviazione ci passano: l'invariante sembrava chiusa. Era chiusa solo sul
-- bordo dell'ARCHIVIAZIONE. Niente impediva a un messaggio ARRIVATO DOPO di
-- rialzare il badge su una topic che nessuno riaprirà — `bumpUnreadCount` non
-- sapeva cosa fosse una topic archiviata.
--
-- Misurato il 26/08/2026, tre settimane dopo quel fix:
--
--   select count(*) from unread u join topics t on t.id = u.topic_id
--   where u.unread_count > 0 and t.archived = 1;   -> 475
--
-- con righe il cui `last_read_at` arriva al 23/08. Un contatore riparato dove
-- si scrive e mai dove si incrementa è riparato sul bordo sbagliato.
--
-- La guardia sta in `server/lib/unread-count.ts` e impedisce che il residuo si
-- riformi. Qui si toglie quello già accumulato.
--
-- SI AZZERA, NON SI CANCELLA la riga: `last_read_at` è la memoria di quando
-- quella conversazione è stata letta l'ultima volta, e non è questo il difetto.
-- I messaggi non si toccano: restano tutti, cambia solo un numero che diceva
-- una cosa falsa.
UPDATE unread
SET unread_count = 0
WHERE unread_count > 0
  AND topic_id IN (SELECT id FROM topics WHERE archived = 1);
