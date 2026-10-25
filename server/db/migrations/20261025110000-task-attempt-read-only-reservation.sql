-- Keep an admission's read-only memory reservation with its live attempt so
-- dispatcher reattachment does not open a second exemption after a restart.
ALTER TABLE task_attempts ADD COLUMN read_only_reservation_gb REAL;
