-- 20261128100000-mail-inbox.sql
--
-- Incoming mail (change posta-per-gli-agenti, rules P1 and P2).
--
-- `app_settings.mailboxes_json` is the declared mailbox list: one list to
-- receive and to send. `mail_messages` holds one row per message, keyed by
-- (mailbox, provider id), headers and a short excerpt only: never the body.
-- `mail_inbox_state` is the per-mailbox cursor, the health of the last reads
-- and the lease that lets one server at a time run a round.
ALTER TABLE app_settings ADD COLUMN mailboxes_json TEXT;

CREATE TABLE IF NOT EXISTS mail_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox       TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  thread_id     TEXT,
  message_id    TEXT,
  in_reply_to   TEXT,
  from_addr     TEXT NOT NULL,
  to_addrs      TEXT NOT NULL DEFAULT '[]',
  subject       TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  auth_results  TEXT,
  sent_at       TEXT,
  received_at   TEXT NOT NULL,
  own           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mailbox, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_received ON mail_messages(mailbox, received_at);

CREATE TABLE IF NOT EXISTS mail_inbox_state (
  mailbox        TEXT PRIMARY KEY,
  cursor         TEXT,
  last_ok_at     TEXT,
  last_try_at    TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  lease_owner    TEXT,
  lease_until    TEXT
);
