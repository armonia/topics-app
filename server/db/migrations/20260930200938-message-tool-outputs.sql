-- 20260930200938-message-tool-outputs.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- Tool call OUTPUT gets its own storage, out of the message row.
--
-- `messages.blocks` is one zstd blob per row, and inside it every tool call
-- carries its whole output (`detail.output` / `content` / `result`, plus a
-- `result` that repeats one of them on older rows). A history page ships none
-- of that text - `leanMessagesForHistory` blanks it and the row fetches it on
-- expand - but reading the row meant decompressing all of it: 848 MB
-- decompressed for 163 MB stored on the live DB, ~456 MB of it the fields the
-- page throws away, and 6.52 MB decompressed to ship 238,929 bytes on one
-- topic.
--
-- A tool call whose movable text reaches MIN_MOVED_CHARS keeps its place in
-- the row with those fields set to '' and a `movedOutput` mark counting what
-- left; the text lives here, one row per message. The full read
-- (`parseBlocksCol`, server/utils.ts) puts it back, so every reader that is
-- not the history page sees the row exactly as before. See
-- server/lib/tool-output-store.ts for the rules and the backfill.
--
-- ON DELETE CASCADE: an output lives exactly as long as its message. Every
-- server connection runs with `PRAGMA foreign_keys = ON` (server/db.ts), and a
-- message is only ever deleted when it is gone for good or re-inserted whole
-- (`saveLocalMessages`, which splits again in the same transaction).
--
-- `body` is zstd of the JSON `{ <tool call id>: { detail?: { key: text },
-- result?: text } }` for every marked call of the row. One row per message and
-- not per call: the outputs of one turn compress together (100.8 MB against
-- 124.9 MB on a copy of the live DB), every reader wants all of them at once,
-- and it is 5,012 rows instead of 78,428.
CREATE TABLE IF NOT EXISTS message_tool_outputs (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  body BLOB NOT NULL
);

-- The incremental backfill of the rows written before this migration: where it
-- got to (message ids in order: stable across VACUUM, unlike rowid) and when it
-- found nothing left. One row.
CREATE TABLE IF NOT EXISTS message_tool_outputs_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_id TEXT NOT NULL DEFAULT '',
  finished_at TEXT
);
INSERT OR IGNORE INTO message_tool_outputs_backfill (id, after_id) VALUES (1, '');
