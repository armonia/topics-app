-- 20261118130000-cron-runs.sql
--
-- Outcome of every run of the external scheduler's jobs (jarvis-channels cron). The scheduler
-- keeps its own log; this copy lets the Dashboard and the per-person usage see the runs.
-- One row per (job, start): syncing the same run twice stays one row.
CREATE TABLE IF NOT EXISTS cron_runs (
  job_id     TEXT NOT NULL,
  job_name   TEXT NOT NULL,
  run_at     INTEGER NOT NULL,
  ended_at   INTEGER,
  duration_ms INTEGER,
  status     TEXT NOT NULL,
  error      TEXT,
  output     TEXT,
  PRIMARY KEY (job_id, run_at)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_time ON cron_runs(run_at DESC);
