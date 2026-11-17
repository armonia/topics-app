-- 20261116120000-ci-after-land.sql
--
-- tasks.ci_after: the landed card whose CI is still to be read (the `after` rule of the CI phase:
-- the card lands at once, the CI measures main afterwards). JSON `{"commit": "<delivery commit that
-- landed>", "who": "human" | "auto" | null}`; NULL = nothing to measure. The queue that reads it lives
-- in memory, so this column is what survives a restart: the periodic sweep puts back every card
-- that still carries it.
ALTER TABLE tasks ADD COLUMN ci_after TEXT;
