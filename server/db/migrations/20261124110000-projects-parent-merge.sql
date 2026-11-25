-- Project families (change worktree-standard, track T6, accorpa / separa).
--
-- A project can sit under another one. The choice "share the parent's board" or
-- "keep my own" is stored on the CHILD:
--   parent_id   projects.id of the parent, NULL for a top-level project. The
--               family is one level deep (enforced by the API, not by SQL).
--   merge_mode  'accorpa' = the parent's board and sidebar entry include this
--               project; 'separa' = it stays a board of its own.
--
-- Nothing in `tasks` or `topics` changes: a card keeps the project_id it was
-- born with, and the parent's board reads a wider set of ids. The backfill of
-- the projects that are really worktrees (their parent comes from git's common
-- dir, which SQL cannot read) is `server/services/project-family-backfill.ts`,
-- run at boot and by `scripts/backfill-project-parents.ts`; both are idempotent.
ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'accorpa' CHECK (merge_mode IN ('accorpa', 'separa'));
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
