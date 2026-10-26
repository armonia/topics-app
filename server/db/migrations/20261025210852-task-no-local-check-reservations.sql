-- Store the no-check reservation separately from attempt history.
CREATE TABLE IF NOT EXISTS task_no_local_check_reservations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  reservation_gb REAL NOT NULL
);
