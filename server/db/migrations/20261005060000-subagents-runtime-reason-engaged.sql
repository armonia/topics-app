-- 20261005060000-subagents-runtime-reason-engaged.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- Two facts a `spawn_agent` child carries for its whole life
-- (openspec/changes/subagent-nativi, SUBAGENT-18 and SUBAGENT-21):
--  - `runtime_reason` is why it was born on its runtime: `asked` (the call
--    named the runtime), `fallback` (the engine could not take it, so the
--    CLI did) or `default` (nothing asked, the engine took it). A CLI child
--    born `asked` resumes on the CLI; any other CLI child, and every row
--    written before this file (NULL), may move to the engine when resumed.
--  - `engaged_at` is when a person first opened the child (seen, focused):
--    from then on it is theirs, so it notifies like any chat and does not
--    leave the view by itself. It outlives a restart, which an in-memory
--    flag did not.
ALTER TABLE subagents ADD COLUMN runtime_reason TEXT;
ALTER TABLE subagents ADD COLUMN engaged_at TEXT;
