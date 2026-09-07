-- 20260907132557-board-id-windows-path.sql
--
-- BOARD IDS BORN ON WINDOWS CARRY THE WHOLE PATH.
--
-- `shared/board.ts:projectIdForPath` builds the id as `<folder>-<hash6>`, and
-- until 06/09 it cut the folder name on `/` alone. A Windows path has no `/`,
-- so the "folder name" was the WHOLE path and the id came out as
-- `C:\Users\<user>\AppData\Local\Temp\board-yv2opn` instead of `board-yv2opn`.
-- Measured on the Windows PC on the first e2e run (card 9ff7427c): the id
-- travels inside a URL path (`/api/boards/<id>/tasks`) where the WHATWG parser
-- rewrites `\` into `/`, so client and server stopped naming the same board and
-- every board page opened empty.
--
-- The function now splits on `[\\/]`. The HASH is untouched (it runs on the
-- full path string), so an existing id changes ONLY in the part in front of the
-- hash, and only when the path contains a backslash: no row written on macOS or
-- Linux moves. This migration realigns the rows already written with the broken
-- id, which are exactly the rows whose `project_id` contains a backslash, by
-- cutting where the function now cuts: everything after the LAST backslash.
-- `…\board-yv2opn` becomes `board-yv2opn`, byte for byte what
-- `projectIdForPath` returns for that same path.
--
-- Three tables hold this id: `tasks`, `board_settings`, `board_memory`.
-- (`worktrees.project_id` is a different id, the `projects.id` uuid, and is not
-- touched.) The recursive CTE is how you take the substring after the last
-- occurrence of a character in SQLite, which has no `reverse()`: strip one
-- leading segment per step until none is left. `char(92)` is the backslash,
-- written that way so no reader has to count escapes.
--
-- Rows whose tail would be EMPTY (a path ending in a backslash, e.g. `C:\`) are
-- left untouched everywhere: there the function keeps the drive letter, and the
-- cut here would produce an id with no name in front of the hash.
--
-- Idempotent by construction: afterwards no `project_id` contains a backslash,
-- so a second run matches nothing.

CREATE TEMP TABLE board_id_realign AS
WITH RECURSIVE broken(old_id) AS (
  SELECT project_id FROM tasks WHERE instr(project_id, char(92)) > 0
  UNION
  SELECT project_id FROM board_memory WHERE instr(project_id, char(92)) > 0
  UNION
  SELECT project_id FROM board_settings WHERE instr(project_id, char(92)) > 0
),
cut(old_id, tail) AS (
  SELECT old_id, old_id FROM broken
  UNION ALL
  SELECT old_id, substr(tail, instr(tail, char(92)) + 1) FROM cut WHERE instr(tail, char(92)) > 0
)
SELECT old_id, tail AS new_id FROM cut WHERE instr(tail, char(92)) = 0 AND tail <> '';

UPDATE tasks
   SET project_id = (SELECT new_id FROM board_id_realign WHERE old_id = tasks.project_id)
 WHERE project_id IN (SELECT old_id FROM board_id_realign);

UPDATE board_memory
   SET project_id = (SELECT new_id FROM board_id_realign WHERE old_id = board_memory.project_id)
 WHERE project_id IN (SELECT old_id FROM board_id_realign);

-- `board_settings.project_id` is the PRIMARY KEY, so the realigned id can
-- already be taken: the same board opened once under the broken id and once
-- under the right one. The row that stays is the one already under the RIGHT id
-- (that is the one the app has been reading and writing); the broken twin is
-- deleted instead of being left as a row nothing can reach any more.

DELETE FROM board_settings
 WHERE project_id IN (SELECT old_id FROM board_id_realign WHERE new_id IN (SELECT project_id FROM board_settings));

UPDATE board_settings
   SET project_id = (SELECT new_id FROM board_id_realign WHERE old_id = board_settings.project_id)
 WHERE project_id IN (SELECT old_id FROM board_id_realign);

DROP TABLE temp.board_id_realign;
