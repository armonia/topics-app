-- 031-task-dispatch.sql — auto-dispatch of a scoped agent when a task enters "todo".
--
-- Adds the DATA that drives + bounds the dispatcher (server/services/task-dispatcher.ts).
-- Config is per-board (board_settings, previously unwired) so the cap/effort/worktree/
-- toggle are user-managed data, not server constants; per-task dispatch STATE lives on
-- the task row so it survives a server restart (boot reconciliation reads it).
--
-- Nothing auto-runs until board_settings.auto_dispatch is turned on for a board.

-- Per-task dispatch state.
ALTER TABLE tasks ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
-- null = not dispatched; queued | starting | working | needs_input (mirrors the card chip).
ALTER TABLE tasks ADD COLUMN dispatch_state TEXT;
-- Last failure reason (stale turn, worktree error, retry cap hit) for the card + logs.
ALTER TABLE tasks ADD COLUMN dispatch_error TEXT;

-- Per-board dispatch config (board_settings already keyed by project_id).
ALTER TABLE board_settings ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_settings ADD COLUMN dispatch_effort TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE board_settings ADD COLUMN dispatch_use_worktree INTEGER NOT NULL DEFAULT 1;
ALTER TABLE board_settings ADD COLUMN dispatch_timeout_min INTEGER NOT NULL DEFAULT 20;
