-- 20260819122701-task-nudge-claim.sql
--
-- Una interruzione, UN SOLLECITO: la rivendicazione del messaggio che il
-- dispatcher inietta nella CHAT del task.
--
-- I commenti di servizio hanno già il loro cancello (`interrupt_claimed_at`,
-- migration del 14/08). La chat no: a ogni ripresa il dispatcher scrive il
-- sollecito di `buildContinueNudge` per esteso, come messaggio dell'utente. Su
-- `topic:7d043b7e` sono finite quattro copie identiche di «Your previous turn
-- on this task was interrupted» in novanta secondi: 00:37:07, 00:38:01,
-- 00:38:18, 00:38:28. Quattro paragrafi sopra la conversazione vera.
--
-- Il cancello non ferma la ripresa (un turno si accende con un messaggio, e il
-- messaggio ci vuole): la prima ripresa della finestra porta il testo intero,
-- le altre una riga sola e numerata. La regola sta in server/services/nudge-gate.ts.
--
-- E sta QUI, non in memoria, per la stessa ragione dell'altro campo: il terzo
-- che sollecita è quasi sempre un processo NUOVO, appena ripartito, ed è il
-- riavvio il motivo per cui sta sollecitando. La RAM gli direbbe che il campo
-- è libero.
ALTER TABLE tasks ADD COLUMN nudge_claimed_at TEXT;
ALTER TABLE tasks ADD COLUMN nudge_fingerprint TEXT;
ALTER TABLE tasks ADD COLUMN nudge_repeats INTEGER NOT NULL DEFAULT 0;
