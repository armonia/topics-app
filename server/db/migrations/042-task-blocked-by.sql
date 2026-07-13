-- Task dependency: this task WAITS (is not dispatch-eligible) until the
-- blocker task reaches `done` (or is archived/deleted). Human-managed from the
-- task drawer; the dispatcher's claim CAS enforces it race-free.
ALTER TABLE tasks ADD COLUMN blocked_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_blocked_by ON tasks(blocked_by_task_id);

-- Opt-in: when this task dispatches, reuse the blocker agent's conversation
-- (same topic/session) instead of a fresh one — the blocker's context is often
-- exactly what the dependent task needs.
ALTER TABLE tasks ADD COLUMN reuse_blocker_context INTEGER NOT NULL DEFAULT 0;
