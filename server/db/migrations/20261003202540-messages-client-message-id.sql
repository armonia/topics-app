-- 20261003202540-messages-client-message-id.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- The key a window mints once per send (`clientMessageId`), written on the
-- person's row the send stores (`server/routes/chat.ts`).
--
-- The route deduped a resend by that key only in memory, for 30 minutes: a
-- message stored, its echo lost with the socket, the server restarted, and
-- the queue's resend under the same key was stored a second time. And the
-- history rows did not carry the key, so a window recognised its own bubble
-- in them by the words alone, and took another send's identical row for it.
--
-- One row per key per session, enforced here and not only checked by the
-- route: two requests with the same key cannot both write. NULL for every row
-- written before this file, and for every row no send keyed (answers, notices,
-- imported turns): those keep the old match by text. No backfill, the keys
-- were never stored anywhere.
ALTER TABLE messages ADD COLUMN client_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_client_message_id
  ON messages(session_key, client_message_id)
  WHERE client_message_id IS NOT NULL;
