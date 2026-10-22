-- Reads of `tasks` that run on a timer walked the whole table: about 1,400
-- pages on the live database of 15/10/2026, read from disk when memory pressure
-- empties SQLite's page cache (`[DB-SLOW]` up to 946 ms). Partial indexes, so
-- each holds only the few rows its read wants (server/lib/task-timer-reads.ts).

-- The dispatcher tick: which boards have queued root cards. `parent_task_id`
-- leads, or the planner prefers idx_tasks_parent, where nearly every card is.
CREATE INDEX IF NOT EXISTS idx_tasks_queued_roots ON tasks(parent_task_id, project_id)
  WHERE archived = 0 AND status = 'todo';

-- The status bar: how many cards are working, and the oldest one's board.
CREATE INDEX IF NOT EXISTS idx_tasks_working ON tasks(in_progress_at, project_id)
  WHERE dispatch_state = 'working';

-- The wait sweep: cards parked in a series, oldest first. `archived` leads for
-- the same reason: alone, `wait_since` loses to idx_tasks_archived.
CREATE INDEX IF NOT EXISTS idx_tasks_waiting ON tasks(archived, wait_since)
  WHERE wait_since IS NOT NULL;
