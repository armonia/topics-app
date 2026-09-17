-- 20260915230316-pending-deliveries.sql
--
-- A DELIVERY WAITING ON THE PRE-REVIEW CHECKS SURVIVES THE RELOAD.
--
-- `pendingDeliveries` (routes/tasks.ts) is the remembered PATCH that the server
-- re-issues to itself when the checks round ends and the client has stopped
-- polling. It lived in RAM only, so a reload forgot it: the round was cut by the
-- shutdown, nothing re-issued the delivery, and the card sat `in_progress` until
-- the agent's next turn asked again — which re-opened the delivery from scratch
-- and realigned the branch on main a second time.
--
-- That mattered from 2026-09-15, when a delivery whose checks are only WAITING
-- (memory floor, spacing, sustained swap, the gate's queue, the pull request CI
-- poll) stopped holding the restart: cutting it is only free if it comes back.
--
-- One row per card, the body as the agent sent it, and the commit the round was
-- measuring — the commit is what says "the same delivery", so the restarted
-- round does not merge main into the worktree again.
CREATE TABLE IF NOT EXISTS pending_deliveries (
  task_id    TEXT PRIMARY KEY,
  pathname   TEXT NOT NULL,
  body_json  TEXT NOT NULL,
  commit_sha TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
