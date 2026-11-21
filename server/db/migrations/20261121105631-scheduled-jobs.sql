-- 20261121105631-scheduled-jobs.sql
--
-- One engine for everything that runs on a schedule (change
-- lavori-programmati-in-topics, rules R1, R4, R5). A job says WHEN (schedule)
-- and WHAT (action); a run is one occurrence taken by the engine, with a state.
-- The board recurrences that lived in scheduled_cards become the first kind of
-- job: action kind 'card'. The old tables are left in place (a revert of the
-- code finds them as they were) and are no longer written.
--
-- schedule_json: {"kind":"cron","expr","tz"} | {"kind":"every","minutes"} | {"kind":"at","at"}
-- action_json:   {"kind":"card","text","status","labels"} | later: command, agent
-- occurrence_key is the UTC instant of the occurrence (or manual:<uuid>), so a
-- restart or a second server cannot take the same occurrence twice.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  project_id    TEXT,
  schedule_json TEXT NOT NULL,
  action_json   TEXT NOT NULL,
  deliver_json  TEXT,
  policy_json   TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at   TEXT,
  created_by    TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS scheduled_jobs_project ON scheduled_jobs(project_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  scheduled_for  TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
    'pending', 'starting', 'running', 'ok', 'error', 'timeout', 'cancelled',
    'skipped', 'missed', 'failed_to_start', 'interrupted')),
  cause          TEXT,
  reason         TEXT,
  missed_count   INTEGER NOT NULL DEFAULT 0,
  task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  process_ref    TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  UNIQUE (job_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS scheduled_job_runs_open ON scheduled_job_runs(status) WHERE status IN ('pending', 'starting', 'running');
CREATE INDEX IF NOT EXISTS scheduled_job_runs_job ON scheduled_job_runs(job_id, created_at);

-- The engine's heartbeat: one row, written at every tick (rule R3).
CREATE TABLE IF NOT EXISTS scheduled_engine_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at TEXT
);

-- Copy of the board recurrences: same id, same next occurrence.
INSERT OR IGNORE INTO scheduled_jobs
  (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_by, created_at, updated_at, deleted_at)
SELECT id, substr(text, 1, 120), project_id,
       json_object('kind', 'cron', 'expr', cron, 'tz', time_zone),
       json_object('kind', 'card', 'text', text, 'status', status, 'labels', json(labels_json)),
       enabled, next_run_at, 'user', created_at, updated_at, deleted_at
FROM scheduled_cards;

-- Cards already born become finished runs (their old local occurrence key is
-- kept under a legacy prefix: it cannot be turned into an instant in SQL).
INSERT OR IGNORE INTO scheduled_job_runs
  (id, job_id, occurrence_key, scheduled_for, status, task_id, created_at, started_at, finished_at)
SELECT id, scheduled_card_id, 'legacy:' || occurrence_key, created_at, 'ok', task_id, created_at, created_at, created_at
FROM scheduled_card_instances;
