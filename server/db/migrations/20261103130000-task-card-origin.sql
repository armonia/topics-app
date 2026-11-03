-- 20261103130000-task-card-origin.sql
--
-- Who opened a card, from where, and whether an agent's card came with what it
-- needs to finish by itself (card a7ba2d05).
--
-- created_source: the channel or session the card was opened from, as text
-- ("session:<key>", "coordinator", or what the caller declared). A field of its
-- own, not a line in the description. NULL = born before the column.
ALTER TABLE tasks ADD COLUMN created_source TEXT;

-- origin_topic_id: the chat the card came from, for DISPLAY only (link and
-- name on the card). It never grants anything: closing power stays on
-- created_by_topic_id, which only the server sets from a resolved session.
ALTER TABLE tasks ADD COLUMN origin_topic_id TEXT;

-- bar: the executable acceptance bar (the check that says the work is done).
ALTER TABLE tasks ADD COLUMN bar TEXT;

-- created_missing: non-NULL when the card was born subject to the agent-card
-- contract (comma list of what was missing at birth, possibly empty). The live
-- list is recomputed on read from the row, so it shrinks as the card is
-- completed; NULL = not subject (a person's card, or one born before the column).
ALTER TABLE tasks ADD COLUMN created_missing TEXT;
