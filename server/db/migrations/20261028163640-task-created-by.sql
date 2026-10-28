-- 20261028163640-task-created-by.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations


--
-- created_by: WHO opened the card, as text. Values: `human` (a person from the
-- interface), `agent:<name>` (an agent or a script calling the API),
-- `cron:<name>` (a schedule). NULL = a card born before the column, or from an
-- internal path (node mirrors); nothing rewrites those.
--
-- It does not replace `created_by_topic_id` (093): that one is the LINK to the
-- topic that backs `isOwnStep`; this is the LABEL that tells whoever reads the
-- board who has to close the card. On 2026-10-28 the cards Jarvis opened sat in
-- review and nobody could tell whose they were.
ALTER TABLE tasks ADD COLUMN created_by TEXT;

--
-- unowned_alerted_at: the last time the server told the coordinator that this
-- card sits in backlog with no owner. It is the dedupe: the alert fires again
-- only if the card was touched AFTER it (updated_at > unowned_alerted_at), i.e.
-- it came back to backlog for a new round. It survives a server restart.
ALTER TABLE tasks ADD COLUMN unowned_alerted_at TEXT;

-- Cards that are ALREADY in backlog must not all fire at the first pass of the
-- check: they have been sitting there since before, and someone has seen them.
-- Mark them alerted now; from here on the normal rule applies.
UPDATE tasks SET unowned_alerted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE status = 'backlog' AND archived = 0;

-- The unowned-backlog check runs on a timer (every reconcile, 10 s): a partial
-- index so it never walks the table (db-sweep-plans.test.ts). The predicate is
-- the first three terms of UNOWNED_BACKLOG_SQL (server/lib/task-timer-reads.ts).
-- `archived` leads, as in 20261024120000: alone, `updated_at` loses to
-- idx_tasks_archived (measured: the plan test caught exactly that).
CREATE INDEX IF NOT EXISTS idx_tasks_backlog_unowned ON tasks(archived, updated_at)
  WHERE archived = 0 AND status = 'backlog' AND parent_task_id IS NULL;
