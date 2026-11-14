-- 20261114080000-close-orphan-attempts.sql
--
-- A turn adopted after a server restart never closed the attempt its dead
-- launch had opened, so the row stayed `running` forever and the card read as
-- a live turn: the CI phase skipped it at every sweep (e8a0ce90, 14/11).
-- The code now closes it (task-dispatcher.ts, reattachTask); this closes the
-- ones already left behind. Only cards no agent is on: an `in_progress` card
-- may really be running, and its own turn end closes the row.
UPDATE task_attempts
SET state = CASE WHEN (SELECT status FROM tasks WHERE tasks.id = task_attempts.task_id) IN ('review', 'done') THEN 'delivered' ELSE 'failed' END,
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE state = 'running'
  AND task_id IN (SELECT id FROM tasks WHERE status IN ('review', 'done', 'backlog', 'todo'));
