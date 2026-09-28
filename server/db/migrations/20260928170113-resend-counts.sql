-- 20260928170113-resend-counts.sql
--
-- HOW MANY TIMES THE RESUME SWEEP HAS RESENT A MESSAGE, kept as a number
-- (card 069f823e).
--
-- The sweep (server/lib/ripresa-boot.ts) counted a message's resends by walking
-- the thread up `parent_id` from the row it judged, taking the highest
-- `ripreso` number and stopping at the first assistant row with none. Every
-- service row that lands under a resent answer is such a row: a sub-agent's
-- report, a system message, a background notice. The walk stopped there, each
-- link counted from zero, and neither MAX_RESUME_ATTEMPTS nor MAX_FREE_PROBES
-- ever triggered (probes of 28/09: seven resends of one message in seven
-- restarts with a report under each answer, twenty of twenty into an API down
-- for good with a background notice under each cut).
--
-- One row per message a resend chain sends: the person's own row, or the copy
-- a resend wrote, once the chain before it was answered. `attempts` and
-- `free_probes` are written with the sweep's trace, before the resend goes
-- out. `last_copy_id` is written by the chat route when the resend writes its
-- copy of the message: it is how the next sweep finds the chain from the
-- chat's last user row, and how it tells that the chain was answered (a turn
-- after that copy ended by itself, closed by the route).
--
-- ROWS WRITTEN BEFORE THIS TABLE. Nothing is backfilled: the resend numbers sit
-- in `messages.blocks`, compressed past 512 bytes, where SQL cannot read them.
-- A chain in flight at deploy has no row here, and no chat it lives in has
-- one: every resend of the sweep since the table exists writes its count, so
-- a chat with none has had no such resend since. There the sweep reads the
-- count as it did before this table, walking the thread up `parent_id`, and
-- no more: the chain goes on from where it was, neither capped nor from zero,
-- and its free probes, which nothing counted, are taken as spent.
CREATE TABLE IF NOT EXISTS resend_counts (
  message_id   TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  free_probes  INTEGER NOT NULL DEFAULT 0,
  last_copy_id TEXT,
  updated_at   TEXT NOT NULL
);
