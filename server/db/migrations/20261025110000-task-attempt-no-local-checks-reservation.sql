-- Keep an exempt card's memory reservation attached to its latest attempt.
CREATE TABLE task_no_local_check_reservations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  reservation_gb REAL NOT NULL
);
