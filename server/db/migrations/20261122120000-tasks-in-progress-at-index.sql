-- The self-check round (change verifica-di-topics) asks every 5 minutes whether
-- any card started inside the last hour. The only index on in_progress_at is
-- partial (working cards), so without this one that read scanned every task.
CREATE INDEX IF NOT EXISTS idx_tasks_in_progress_at ON tasks(in_progress_at);
