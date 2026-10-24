-- The side-call ledger (server/usage/side-calls.ts): one row per `complete()`
-- a provider answers outside a chat turn. `usage_records` existed since 001
-- and nobody wrote it; these columns say what the call was for and split the
-- prompt into its cache shares, so a title written to the one-hour cache can
-- be told apart from one read from it.
ALTER TABLE usage_records ADD COLUMN purpose TEXT;
ALTER TABLE usage_records ADD COLUMN provider TEXT;
ALTER TABLE usage_records ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN duration_ms INTEGER;
