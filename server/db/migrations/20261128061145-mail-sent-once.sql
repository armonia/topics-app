-- 20261128061145-mail-sent-once.sql
--
-- A mail an agent asks for leaves once, even across a restart (change
-- posta-per-gli-agenti, rule P8). The mail uses the SAME register as the
-- outcome of a scheduled job (`deliveries`, rule R23): no second register.
--
-- What the mail needs and the register did not have:
--  - `pending`: the confirmation is a row. It holds the message while the
--    person reads it, so a restart does not lose it and a "Conferma" given
--    afterwards makes the server send from the row. `pending` is NOT touched by
--    the boot rule (only `delivering` becomes `unknown`).
--  - `payload_json`: the message itself (account, recipients, subject, body,
--    frozen attachments, the thread row of the question). A job run never
--    writes it.
--
-- SQLite cannot change a CHECK in place, so the table is rebuilt with the same
-- columns plus `payload_json`, and every row is copied as it is.
CREATE TABLE deliveries_rebuilt (
  key          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'delivery_failed', 'unknown', 'not_delivered', 'empty')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  payload_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO deliveries_rebuilt (key, kind, state, attempts, detail, created_at, updated_at)
  SELECT key, kind, state, attempts, detail, created_at, updated_at FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_rebuilt RENAME TO deliveries;
CREATE INDEX IF NOT EXISTS idx_deliveries_kind_state ON deliveries (kind, state);
