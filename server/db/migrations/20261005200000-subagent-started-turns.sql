-- 20261005200000-subagent-started-turns.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- Every turn a native sub-agent's chat really opened, by name, written when
-- the chat route starts its stream (`recordTurnStart`): openspec/changes/
-- subagent-nativi, SUBAGENT-19. A turn exists only if it is here. A user row
-- that opened none (a refused request, a request cut before its stream) is no
-- turn, and no `lost` is ever owed for it. The turn the parent never heard of
-- is the last one here that is not in subagent_reported_turns.
CREATE TABLE IF NOT EXISTS subagent_started_turns (
  subagent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (subagent_id, turn_id)
);
