-- 20261128140000-mail-waits.sql
--
-- Waiting for a mail (change posta-per-gli-agenti, rules P3, P4, P5).
--
-- One row per wait: who waits (a card or a chat), on which mailbox, the
-- criterion (the sender is always in it) and the deadline. The match and the
-- expiry are conditional updates (`WHERE status = 'open'`), so a wait is
-- completed once whoever races for it. The wake is written on the same row, in
-- the same statement that completes the wait: `wake_state` goes pending, then
-- delivered (or dropped when the owner is gone), and the wait id is the key the
-- delivery carries, so a restart between the turn and the mark opens no second
-- turn. The wake text never carries the body: the table has no column for it.
CREATE TABLE IF NOT EXISTS mail_waits (
  id                  TEXT PRIMARY KEY,
  owner_kind          TEXT NOT NULL CHECK (owner_kind IN ('card', 'chat')),
  owner_id            TEXT NOT NULL,
  mailbox             TEXT NOT NULL,
  from_match          TEXT NOT NULL,
  subject_contains    TEXT,
  thread_id           TEXT,
  in_reply_to         TEXT,
  since               TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'expired', 'cancelled')),
  matched_message_id  INTEGER,
  reject_note         TEXT,
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  wake_state          TEXT NOT NULL DEFAULT 'none' CHECK (wake_state IN ('none', 'pending', 'delivered', 'dropped')),
  wake_text           TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_waits_open ON mail_waits(status, mailbox, expires_at);
CREATE INDEX IF NOT EXISTS idx_mail_waits_owner ON mail_waits(owner_kind, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_mail_waits_wake ON mail_waits(wake_state);
