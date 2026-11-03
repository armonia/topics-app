-- 20261102152526-task-created-source.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations


-- created_source: where the request came from (a session, a channel), as text
-- the caller declared. created_missing: what an agent's card lacked at birth
-- (context, folder, bar), one item per line; NULL = complete or not an agent's.
-- Both NULL on every card written before.
ALTER TABLE tasks ADD COLUMN created_source TEXT;
ALTER TABLE tasks ADD COLUMN created_missing TEXT;
