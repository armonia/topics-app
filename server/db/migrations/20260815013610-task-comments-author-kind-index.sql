-- 20260815013610-task-comments-author-kind-index.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

-- L'INDICE CHE MANCAVA SOTTO IL CONTATORE DEI MESSAGGI UMANI.
--
-- `withSubtaskCounts` aggrega `task_comments` per rispondere a una domanda sola
-- («quanti messaggi ha mandato una persona su questa card»), e lo fa su OGNI
-- lista della board e su OGNI apertura di task. L'unico indice esistente
-- (`idx_task_comments_task`) copre `task_id` e basta: il filtro su autore e
-- tipo restava una lettura di tutte le righe del task, e `task_comments` è la
-- tabella che cresce più in fretta di tutte (11.994 righe misurate il
-- 2026-08-15, contro 2.135 task).
--
-- Le tre colonne nell'ordine in cui la query le stringe — `task_id` per il
-- taglio, poi i due valori dell'uguaglianza — così l'indice COPRE il predicato
-- e il conteggio non tocca la tabella.
--
-- Solo questo, e niente altro in questo file: su una macchina di sviluppo la
-- migration si applica al database VIVO nei secondi in cui il file compare.
-- `CREATE INDEX` su ~12k righe è immediato; qualunque altra cosa qui dentro non
-- lo sarebbe.
CREATE INDEX IF NOT EXISTS idx_task_comments_task_author_kind
  ON task_comments(task_id, author, kind);
