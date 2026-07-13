-- 038: auto-dispatch becomes ONE global switch.
--
-- The "start" toggle now lives on every board header — including the global
-- board, which aggregates many projects and therefore can't own a per-board
-- row. The reserved board_settings row project_id='*' holds the switch;
-- per-board rows keep their own cap/effort/worktree/timeout.
--
-- Seed it ON if ANY board had auto_dispatch on, so a live setup that was
-- dispatching keeps dispatching after the upgrade (a silent OFF default would
-- strand every Todo).
INSERT OR IGNORE INTO board_settings (project_id, auto_dispatch, max_agents)
SELECT '*', COALESCE(MAX(auto_dispatch), 0), 2 FROM board_settings;
