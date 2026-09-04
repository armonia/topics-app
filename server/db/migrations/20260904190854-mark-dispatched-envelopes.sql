-- 20260904190854-mark-dispatched-envelopes.sql
--
-- THE ENVELOPES NOBODY TYPED, MARKED AT LAST.
--
-- The dispatcher opens every board turn with a `user` row it wrote itself: the
-- kickoff, the resume, the nudge, the last-turn warning. `server/lib/user-row-marks.ts`
-- now stamps `[{"kind":"dispatched-envelope"}]` on those rows as they are
-- written, but everything written before that stopped at the push trigger and
-- reached the table with a NULL `blocks`. On the live DB that is 2,301 rows
-- rendered as words a person typed, in a bubble with an edit button on it.
--
-- The predicate is ANCHORED at the start of the content on purpose. A person
-- quoting "Human update on task" halfway through a sentence is saying
-- something, and marking that row would collapse their message into a folded
-- envelope nobody can open. `LIKE 'x%'` cannot reach the middle of a line.
--
-- Three more guards, and each one is a row this must NOT touch:
--   * `role = 'user'` only, because an assistant echoing the opening is prose;
--   * `blocks IS NULL` only, so a row already carrying marks (a goal nudge, an
--     envelope written by the new code) keeps exactly what it has;
--   * no backfill of anything else: the column stays NULL where we cannot tell.

UPDATE messages SET blocks = '[{"kind":"dispatched-envelope"}]'
WHERE role = 'user' AND blocks IS NULL AND (
  content LIKE 'You are the exclusive owner of task%' OR
  content LIKE 'Human update on task%' OR
  content LIKE 'Your previous turn on this task was interrupted%' OR
  content LIKE 'LAST TURN on%');
