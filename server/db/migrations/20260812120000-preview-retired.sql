-- «Anteprima ritirata» smette di essere un MESSAGGIO e diventa uno STATO.
--
-- La bonifica delle anteprime false ha lasciato una nota nel thread di 23 card.
-- Un messaggio non invecchia e non si corregge: dove l'anteprima è tornata, la
-- nota continua a dire il contrario. Il fatto «questa card non ha un'anteprima,
-- e il motivo è che ne aveva una falsa» appartiene alla card.
--
-- NESSUNA riga cancellata: le note restano: sono la storia di cosa è successo.
-- Qui si aggiunge solo il posto dove quel fatto può invecchiare bene.
ALTER TABLE tasks ADD COLUMN preview_retired_at TEXT;
ALTER TABLE tasks ADD COLUMN preview_retired_reason TEXT;

-- Recupero del passato: le 23 note già scritte non hanno mai avuto una colonna
-- scritta al momento giusto. Si accende lo stato SOLO dove l'anteprima non è
-- tornata — dove c'è, la nota è già superata e accendere lo stato sarebbe
-- ripetere la bugia in un posto nuovo.
UPDATE tasks SET
  preview_retired_at = (
    SELECT max(c.created_at) FROM task_comments c
    WHERE c.task_id = tasks.id AND c.content LIKE '⚠️ Anteprima RITIRATA%'
  ),
  preview_retired_reason =
    'l''immagine era byte per byte identica a quella di altre card: non era evidenza di questo lavoro'
WHERE (preview_image IS NULL OR trim(preview_image) = '')
  AND EXISTS (
    SELECT 1 FROM task_comments c
    WHERE c.task_id = tasks.id AND c.content LIKE '⚠️ Anteprima RITIRATA%'
  );
