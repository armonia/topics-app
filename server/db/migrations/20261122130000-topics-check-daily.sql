-- The daily self-check (change verifica-di-topics, CHECK-04): one row per local
-- day. The row is written BEFORE the model is asked, so a second call the same
-- day finds it and does nothing: one reading a day, whatever happens to it.
CREATE TABLE IF NOT EXISTS topics_check_daily (
  day          TEXT PRIMARY KEY,
  verdict_json TEXT NOT NULL
);
