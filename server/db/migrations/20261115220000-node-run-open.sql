-- 20261115220000-node-run-open.sql
--
-- Whether the run in `node_run_id` is still OPEN on the node. The id stays on the card after a
-- delivery lands (the next dispatch must still cancel the finished copy), so on its own it cannot
-- tell a live orphan of a restart from a card a human closed and dragged back to In Progress by hand
-- (15/11: a done card was relaunched on the node after a restart).
ALTER TABLE tasks ADD COLUMN node_run_open INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET node_run_open = 1 WHERE node_run_id IS NOT NULL AND status = 'in_progress';
