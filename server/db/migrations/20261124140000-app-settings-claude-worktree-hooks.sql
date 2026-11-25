-- Whether the Claude Code sessions Topics launches carry the worktree hooks
-- (change worktree-standard, track T9): 'off' | 'topics'. NULL = never touched =
-- 'topics', so every `--worktree` and `isolation: worktree` of a Topics session
-- lands under the worktree root where the cleanup sees it.
ALTER TABLE app_settings ADD COLUMN claude_worktree_hooks TEXT;
