-- 20261030225403-board-workflows.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations


--
-- Board workflows (openspec/changes/workflow-per-progetto). A board column is a
-- STAGE on top of one of the five statuses: `tasks.status` and its CHECK do not
-- change, and the dispatcher, the tray and the MCP enum keep reading it.
--
-- stage: which column of the board's workflow the card sits in, when that is
-- not the default column of its status (`triage`, `ai_review`,
-- `human_review`). NULL = the default column: every card born before this
-- migration, and every card on a board with the default workflow.
ALTER TABLE tasks ADD COLUMN stage TEXT;

-- human_ask: the question for the person a delivery carries. On a board with AI
-- review it is what sends a card opened by an agent to Human review instead of
-- back to whoever opened it (rule of 28/10: in review only what the person has
-- to see). NULL = no question.
ALTER TABLE tasks ADD COLUMN human_ask TEXT;

-- ai_review_reminded_at: the last time the coordinator was reminded that this
-- card sits in AI review and nobody closed it. Same dedupe as
-- `unowned_alerted_at`: the reminder fires again only if the card was touched
-- after it. The first notice, at the moment the card enters AI review, goes to
-- whoever opened it and needs no column.
ALTER TABLE tasks ADD COLUMN ai_review_reminded_at TEXT;

-- One row per scope: '*' is the global default, any other value a project id.
-- The project row wins over the global one; no row at all = the `default`
-- preset, the five columns of before. A preset id and not the columns: the
-- columns are code (`shared/workflow.ts`), so a preset that grows a column
-- changes every board using it without rewriting rows.
CREATE TABLE IF NOT EXISTS board_workflows (
  scope TEXT PRIMARY KEY,
  preset TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
