-- The worktrees of each machine as its primary sees them (change worktree-standard,
-- track T12). Each server keeps its own `worktrees` table; the primary keeps one JSON
-- per machine, written by the heartbeat from what the node reports:
--   {"supported": bool, "summary": {root, count, bytes, rootFreeGb, foreign, ghosts,
--    orphans, scanMs, at} | null}
-- NULL = never reported (a machine the primary has not asked yet).
ALTER TABLE machines ADD COLUMN worktree_summary TEXT;
