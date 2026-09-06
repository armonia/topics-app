-- 20260906115130-task-machine-id.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

--
-- A task MAY name the machine it has to run on. NULL = this machine, which is
-- every card that exists today. Mirror of 021-topics-machine-id.sql for topics.
-- FK ON DELETE SET NULL so removing a machine degrades the card to local
-- instead of leaving it pointing at a row that is gone.

ALTER TABLE tasks ADD COLUMN machine_id TEXT
  REFERENCES machines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_machine ON tasks(machine_id);
