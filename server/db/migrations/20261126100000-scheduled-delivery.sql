-- 20261126100000-scheduled-delivery.sql
--
-- Delivery of a job's outcome outside the app, and failure alerts (change
-- lavori-programmati-in-topics, rules R21 to R24).
--
-- `deliveries` is the register of "once only" sends. The CALLER gives the key
-- (a job run id today, a mail send tomorrow), the state is written BEFORE the
-- adapter is called, and a row found `delivering` at boot becomes `unknown`:
-- it may have gone out, so it is never started again by itself.
-- `owner_alerts` holds one row per (scope, local day): the daily limit of an
-- alert to the owner, kept in SQLite so a restart cannot send a second one.
-- `scheduled_delivery_json` is the app setting: adapter command, owner
-- destination, quiet hours and whether agent-made jobs ask first.
CREATE TABLE IF NOT EXISTS deliveries (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('delivering', 'delivered', 'delivery_failed', 'unknown', 'not_delivered', 'empty')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_alerts (
  scope   TEXT NOT NULL,
  day     TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (scope, day)
);

ALTER TABLE app_settings ADD COLUMN scheduled_delivery_json TEXT;
