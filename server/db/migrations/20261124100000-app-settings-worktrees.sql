-- Worktree settings (change worktree-standard, track T1). Machine preferences,
-- all NULL = never touched = the default of the code, so nothing changes until
-- somebody opens the form.
--   worktree_root              absolute folder; NULL/empty = <topicsHome>/worktrees
--   worktree_max_per_project   cap on worktrees of one project (default 20)
--   worktree_disk_floor_gb     free disk under which dispatch stops (default 12)
--   cargo_target_mode          'shared' | 'per-worktree' (default 'shared')
--   gc_foreign                 'off' | 'merged' (default 'off')
--   worktree_abandon_days      days of silence before a branch counts stale (default 7)
--   worktree_quarantine_days   days a ghost folder stays in {root}/.quarantine before it is deleted (default 7)
ALTER TABLE app_settings ADD COLUMN worktree_root TEXT;
ALTER TABLE app_settings ADD COLUMN worktree_max_per_project INTEGER;
ALTER TABLE app_settings ADD COLUMN worktree_disk_floor_gb INTEGER;
ALTER TABLE app_settings ADD COLUMN cargo_target_mode TEXT;
ALTER TABLE app_settings ADD COLUMN gc_foreign TEXT;
ALTER TABLE app_settings ADD COLUMN worktree_abandon_days INTEGER;
ALTER TABLE app_settings ADD COLUMN worktree_quarantine_days INTEGER;
