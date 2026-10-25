-- Keep an admission's no-local-checks memory reservation with its live attempt so
-- dispatcher reattachment does not open a second exemption after a restart.
ALTER TABLE task_attempts ADD COLUMN no_local_checks_reservation_gb REAL;
