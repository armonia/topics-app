-- 20261128090000-review-remeasure-tries.sql
--
-- How many times the review sweep measured the commit a card delivers, kept on
-- the card so a server restart does not reset the count to 1/3 (the question
-- after three tries never fired, because the server restarts every land).
ALTER TABLE tasks ADD COLUMN remeasure_commit TEXT;
ALTER TABLE tasks ADD COLUMN remeasure_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN remeasure_at INTEGER NOT NULL DEFAULT 0;
