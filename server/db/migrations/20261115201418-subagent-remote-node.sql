-- 20261115201418-subagent-remote-node.sql
--
-- A `spawn_agent` child whose run lives on a paired node, not a PTY on this
-- machine (openspec/changes/sottoagenti-nodo, trace 4). Both NULL = the
-- historical case, a local child. `stop_agent` on a row with both set calls
-- `cancelRun` on that node instead of killing a local process that does not
-- exist for it.
ALTER TABLE subagents ADD COLUMN remote_machine_id TEXT;
ALTER TABLE subagents ADD COLUMN remote_run_id TEXT;
