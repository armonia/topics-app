-- The first-run screen is shown until the owner has seen it.
ALTER TABLE app_settings ADD COLUMN first_run_done_at TEXT;
