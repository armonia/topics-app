-- 20261113140000-node-run-id.sql
--
-- The run a card last created on a paired node, kept on the card. It used to live
-- in a Map in memory, so a restart of this server forgot it, the next dispatch did
-- not cancel the old copy, and the node handed the finished one back (13/11).
ALTER TABLE tasks ADD COLUMN node_run_id TEXT;
