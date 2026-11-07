-- 20261107200000-plan-hierarchy.sql
--
-- The Plan view: Project -> Area -> Milestone -> Task -> Sources, laid over
-- the existing board. No card is copied: the card stays the truth about its
-- status, the plan only says where it belongs. Dropping these tables leaves
-- the board untouched.

-- A group of features inside a project. project_id is the board key used by
-- tasks.project_id, with no FK on purpose (the board has virtual projects).
CREATE TABLE IF NOT EXISTS plan_areas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_areas_project ON plan_areas(project_id);

CREATE TABLE IF NOT EXISTS plan_milestones (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES plan_areas(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  expected_result TEXT,
  completion_criteria TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_milestones_area ON plan_milestones(area_id);

-- One card belongs to at most one milestone: the PRIMARY KEY on task_id is
-- the constraint that prevents duplicates in the plan.
CREATE TABLE IF NOT EXISTS plan_task_links (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES plan_milestones(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_task_links_milestone ON plan_task_links(milestone_id);

-- External references attached to a card or a milestone (exactly one of the two).
CREATE TABLE IF NOT EXISTS plan_sources (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES plan_milestones(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'pr', 'branch', 'commit', 'check', 'cron', 'other')),
  label TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  CHECK ((task_id IS NULL) <> (milestone_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_plan_sources_task ON plan_sources(task_id);
CREATE INDEX IF NOT EXISTS idx_plan_sources_milestone ON plan_sources(milestone_id);
