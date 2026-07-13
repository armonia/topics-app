-- 040: per-task agent effort metrics.
--
-- agent_ms     = cumulative wall-clock of the agent's turns on this task
--                (accumulated by the dispatcher around each runTurn, across
--                retries and resumes).
-- agent_tokens = cumulative tokens consumed by those turns (delta of the
--                session transcript's usage records per turn — best-effort:
--                0 when the transcript isn't resolvable).
ALTER TABLE tasks ADD COLUMN agent_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN agent_tokens INTEGER NOT NULL DEFAULT 0;
