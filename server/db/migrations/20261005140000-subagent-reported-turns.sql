-- 20261005140000-subagent-reported-turns.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- Every turn of a native sub-agent that reached its parent, by name
-- (openspec/changes/subagent-nativi, SUBAGENT-11 and SUBAGENT-19). A turn's
-- name is the id of the user row it answers, carried by its start and by every
-- end the chat route records. One turn is one result: a second end of a turn
-- already here is ignored, after a restart too. `status` is how it ended, so
-- the boot closes a waiting child the way the live path would.
CREATE TABLE IF NOT EXISTS subagent_reported_turns (
  subagent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (subagent_id, turn_id)
);
