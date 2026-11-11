-- 20261111043101-scheduled-run.sql
--
-- A card whose work is done by a scheduled run outside Topics (a timed job of
-- an assistant): who runs it and when. While `scheduled_by` is set the
-- dispatcher never claims the card, at any hour: the run does the work, and an
-- agent started on top of it would do it twice (a second mail, a second call to
-- a client). The card stays in todo, where its owner expects planned work, and
-- the front says who and when.
ALTER TABLE tasks ADD COLUMN scheduled_at TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_by TEXT;
