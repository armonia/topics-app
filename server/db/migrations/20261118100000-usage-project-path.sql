-- A call made outside the engine (a delegated job) has no topic, so it names its project directly.
ALTER TABLE usage_records ADD COLUMN project_path TEXT;
