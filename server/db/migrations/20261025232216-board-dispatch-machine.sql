-- 20261025232216-board-dispatch-machine.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations


--
-- Per-board default execution machine: the rule for WHICH cards go to a paired
-- node (e.g. "repos with a git origin that run on Windows go to the PC, the
-- personal board stays here"). NULL = no default, a card runs on this machine
-- unless it names another one. `TaskService.create` copies it into
-- `tasks.machine_id` when the creation request does not say. FK ON DELETE SET
-- NULL, same as `tasks.machine_id`: removing the machine degrades the board to
-- local instead of leaving a default that points at a row that is gone.
ALTER TABLE board_settings ADD COLUMN dispatch_machine_id TEXT
  REFERENCES machines(id) ON DELETE SET NULL;
