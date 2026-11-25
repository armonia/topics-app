-- 20261120090000-board-aliases.sql
--
-- A board id is `basename + hash of the path STRING`. When a project folder
-- moves and a symlink is left at the old path, the same project has two ids and
-- an external caller still holding the old one used to land on a new, empty
-- board (card 266a3e1e). The product had no notion of "the project moved":
-- the cards had been re-pointed by hand in the DB, nothing recorded where from.
--
-- This table is that record. old_id -> new_id, written by the symlink scan in
-- `server/lib/board-alias.ts`, read at the entrance of every /api/boards/:id
-- route. Nothing already written is rewritten: no existing id changes.
CREATE TABLE IF NOT EXISTS board_aliases (
  old_id     TEXT PRIMARY KEY,
  new_id     TEXT NOT NULL,
  old_path   TEXT,
  created_at INTEGER NOT NULL
);
