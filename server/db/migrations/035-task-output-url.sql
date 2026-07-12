-- 035: reviewable output per task (KANBAN-09).
-- The dispatched agent (or a human) can attach ONE http(s) URL — a dev server,
-- a rendered page, a report — that the board's task detail shows in its
-- review panel. Validation (scheme allowlist) lives in the task service.
ALTER TABLE tasks ADD COLUMN output_url TEXT;
