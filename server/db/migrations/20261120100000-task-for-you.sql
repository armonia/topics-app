-- 20261120100000-task-for-you.sql
-- INERT: nothing writes or reads these columns (the summary sweep was removed, card 6b90e92c).
--
-- The plain-words summary of a card in Review («Per te»): four short lines the
-- system writes from the description, delivery, comments and question, and the
-- key of the material it was written from, so a changed thread is re-read and
-- an unchanged one is not paid for twice.
ALTER TABLE tasks ADD COLUMN for_you TEXT;
ALTER TABLE tasks ADD COLUMN for_you_key TEXT;
