-- The side-call ledger (server/usage/side-calls.ts): one row per `complete()`
-- a provider answers. `usage_records` existed since 001 and nobody wrote it.
--
-- WHY A REBUILD, not ADD COLUMNs. Some providers (codex, acp, muse) do not
-- report what a call consumed. Their calls still get a row, with the tokens and
-- the cost NULL: "not measured" is a different fact from "free", and a zero
-- would sum into the totals as if it were measured. 001 declared the token and
-- cost columns NOT NULL DEFAULT 0, and SQLite cannot drop a NOT NULL, so the
-- table is copied into a new one (same pattern as 029 and 066). Nothing
-- references it by FK; its four indexes are recreated below.
--
-- New columns: what the call was for, the provider, the disjoint cache shares
-- (so a title written to the one-hour cache can be told apart from one read
-- from it), the duration, `measured` (1 = the provider reported a usage) and
-- `error` (why the call failed; NULL when it answered).

CREATE TABLE usage_records_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  topic_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  purpose TEXT,
  provider TEXT,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_creation_1h_tokens INTEGER,
  duration_ms INTEGER,
  measured INTEGER NOT NULL DEFAULT 1,
  error TEXT
);

INSERT INTO usage_records_new (id, timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens, cost_usd)
SELECT id, timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens, cost_usd
FROM usage_records;

DROP TABLE usage_records;
ALTER TABLE usage_records_new RENAME TO usage_records;

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_key);
CREATE INDEX IF NOT EXISTS idx_usage_topic ON usage_records(topic_id);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);
