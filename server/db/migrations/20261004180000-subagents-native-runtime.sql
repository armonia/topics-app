-- 20261004180000-subagents-native-runtime.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- A `spawn_agent` child can now run on the Topics engine instead of a Claude
-- CLI in a PTY (openspec/changes/subagent-nativi): it is a chat of its own,
-- with a topic, a session key and turns sent through the chat route.
--  - `runtime` says which of the two it is. Every row written before this file
--    is a CLI child, hence the default.
--  - `session_key` is the child chat's `topic:<id8>`, NULL for a CLI child. A
--    native child that spawns its own is the parent of the next row under THAT
--    key, so the depth walk (SUBAGENT-15) goes through this column.
--  - `tools` is the profile's `tools:` line as the engine names them (JSON
--    array), NULL when the profile does not restrict them or there is none.
ALTER TABLE subagents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE subagents ADD COLUMN session_key TEXT;
ALTER TABLE subagents ADD COLUMN tools TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subagents_session_key ON subagents (session_key) WHERE session_key IS NOT NULL;
