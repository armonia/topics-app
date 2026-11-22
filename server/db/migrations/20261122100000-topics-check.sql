-- The self-check round (change verifica-di-topics, CHECK-01 / CHECK-02).
-- One sample every 5 minutes, kept 7 days by the round itself; sample_json is
-- what `sampleTopics` read from the database at `at` (epoch ms).
CREATE TABLE IF NOT EXISTS topics_check_samples (
  at          INTEGER PRIMARY KEY,
  sample_json TEXT NOT NULL
);

-- Thresholds and declared proofs, as one JSON object; NULL = the code defaults and no proofs.
ALTER TABLE app_settings ADD COLUMN topics_check_json TEXT;
