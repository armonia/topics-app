-- 20261001203100-subagents.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- One row per `spawn_agent` child, keyed by its agentId (the id of its
-- terminal_sessions row). It holds what the child was launched with and what
-- it has reported, so the things that used to live in memory survive a restart
-- (openspec/changes/subagent-tool-standard, SUBAGENT-14 and 15):
--  - the launch (model, agent_type, effort, cwd, branch, claude_session_id) is
--    what `send_to_agent` needs to bring a retired, stopped or lost child back
--    with `--resume`, after its terminal_sessions row is gone;
--  - `state` is what the limits count: only `running` holds a slot;
--  - `turns_reported` is the per-turn dedup of the result (SUBAGENT-11);
--  - `pending_results` is a result written at once and not yet delivered to
--    the parent chat, because the parent's turn was in flight (SUBAGENT-12).
--
-- No foreign key to terminal_sessions on purpose: a stopped child's terminal
-- row is deleted, and this row is exactly what has to outlive it.
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  parent_session_key TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  agent_type TEXT,
  effort TEXT,
  prompt_snippet TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  claude_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'retired', 'stopped', 'lost')),
  turns_reported INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT,
  pending_results TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

-- The two questions asked of this table on every spawn: how many children a
-- parent has running, and how many run on the whole machine.
CREATE INDEX IF NOT EXISTS idx_subagents_parent_state ON subagents (parent_session_key, state);
CREATE INDEX IF NOT EXISTS idx_subagents_state ON subagents (state);
