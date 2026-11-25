-- 20261121160000-scheduled-job-command-output.sql
--
-- What a command run leaves in the history (rules R12, R14 of change
-- lavori-programmati-in-topics): the exit code, and the tail of stdout and of
-- stderr, written when the run closes. The history is kept 30 days.
ALTER TABLE scheduled_job_runs ADD COLUMN exit_code INTEGER;
ALTER TABLE scheduled_job_runs ADD COLUMN stdout_tail TEXT;
ALTER TABLE scheduled_job_runs ADD COLUMN stderr_tail TEXT;
