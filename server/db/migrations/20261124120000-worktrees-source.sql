-- Who made a worktree (change worktree-standard, track T8). A worktree made by
-- another tool (the Claude Code hook, Codex, a hand-made `git worktree add`) is
-- registered through POST /api/worktrees/register and keeps its creator here.
--   source       'topics' | 'claude-code' | 'claude-desktop' | 'codex' | 'jcode'
--                | 'muse' | 'workflow' | 'adopted'; existing rows read 'topics'
--   session_ref  the creator's session id or transcript path; NULL when unknown
ALTER TABLE worktrees ADD COLUMN source TEXT NOT NULL DEFAULT 'topics';
ALTER TABLE worktrees ADD COLUMN session_ref TEXT;
