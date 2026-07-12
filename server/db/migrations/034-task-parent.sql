-- 034 — nested tasks (kanban-agent-authoring, subtask cascade).
--
-- Self-referential parent link, unlimited depth. The parent is set ONLY at
-- creation (no re-parenting API), so cycles are impossible by construction:
-- a fresh id can never be an ancestor of an existing row.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
