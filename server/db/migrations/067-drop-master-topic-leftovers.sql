-- 067: rimuove i residui della modalità "Master Topic" (migration 026) e le
-- tabelle dei tag.
--
-- MASTER TOPIC. La 026 introduceva un'orchestrazione Master/Teammate mai
-- completata. Metà di quello che ha creato è invece diventato il cuore della
-- board — `tasks.assigned_topic_id` (96 righe) e `tasks.claude_task_id` (47) —
-- quindi la migration NON si annulla in blocco: si toglie solo la parte che non
-- è mai stata collegata a niente.
--
--   • `task_events`             — 0 righe, zero SELECT/INSERT in tutto il repo;
--   • `topics.parent_topic_id`  — 0 valori non nulli, zero query;
--   • `topics.agent_team_role`  — 0 valori non nulli, zero query.
--
-- TAG. `tags` e `task_tags` esistono dalla 001. Il CRUD `/api/tags` era servito
-- dal server ma nessun componente del client lo ha mai chiamato e non esiste una
-- UI dei tag: 0 righe in entrambe le tabelle, 0 riferimenti fuori dalla route
-- (rimossa insieme a questa migration).
--
-- Tutto ciò che segue è stato verificato sul DB reale prima di scriverlo: se una
-- di queste tabelle o colonne avesse avuto anche una riga, non sarebbe in questo
-- file. SQLite ≥ 3.35 supporta DROP COLUMN, e Bun ne incorpora una più recente.

DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tags;

DROP INDEX IF EXISTS idx_topics_parent;
DROP INDEX IF EXISTS idx_topics_team_role;

ALTER TABLE topics DROP COLUMN parent_topic_id;
ALTER TABLE topics DROP COLUMN agent_team_role;
