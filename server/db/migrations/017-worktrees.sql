-- 017-worktrees.sql: Add `worktrees` table — first-class Worktree entity.
--
-- Why: enable parallel agent runs on the same repo across different
-- branches. Each worktree is a checked-out git working copy at a specific
-- branch, with a unique on-disk path under `~/.topics/worktrees/<slug>/<name>/`
-- (configurable via env TOPICS_WORKTREES_DIR).
--
-- The (project_id, name) pair is unique per project so multiple projects
-- can each have a worktree called "lyrical-cobra" without collision. The
-- abs_path column is globally UNIQUE because two different worktree rows
-- pointing at the same directory on disk would corrupt git state.
--
-- The `mode` enum tracks how the worktree was created so deletion knows
-- whether it owns the underlying git branch:
--   - branch:   git worktree add -b <branch> <path> <base_ref>
--               (we own the branch and delete it on worktree deletion)
--   - reuse:    git worktree add <path> <existing_branch>
--               (branch is shared, do NOT delete on worktree deletion)
--   - detached: git worktree add --detach <path> <ref>
--               (no branch, branch_name stays NULL)
--
-- The `status` enum is the materialisation state:
--   - pending: row exists, on-disk worktree being created (UI shows loader)
--   - ready:   git worktree is fully checked out and usable
--   - error:   git operation failed; row preserved with stderr in
--              error_message so the user can retry or manually clean up
--
-- Backward-compat: this migration only creates a new table; nothing
-- existing is touched.

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch_name TEXT,
  base_ref TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('branch', 'reuse', 'detached')),
  abs_path TEXT NOT NULL UNIQUE,
  is_pushed INTEGER NOT NULL DEFAULT 0,
  branch_renamed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready', 'error')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_project_name
  ON worktrees(project_id, name);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (17, '017-worktrees', datetime('now'));
