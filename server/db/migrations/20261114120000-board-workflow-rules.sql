-- 20261114120000-board-workflow-rules.sql
-- The rules of a board's workflow beside its columns: whether accepted work
-- goes through the CI phase, and which paths of the repository a person must
-- look at before a card touching them lands (on top of the generic list in
-- server/services/auto-land.ts). Same scopes as board_workflows: '*' global,
-- any other value a project id. NULL = inherit: the CI switch from the global
-- row (then on), the paths add the global row's to the project's.
-- IF NOT EXISTS: the table can be made ahead of the code that reads it.
CREATE TABLE IF NOT EXISTS board_workflow_rules (
  scope TEXT PRIMARY KEY,
  ci_phase INTEGER,
  person_paths TEXT,
  updated_at TEXT NOT NULL
);
