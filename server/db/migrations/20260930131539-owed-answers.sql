-- 20260930131539-owed-answers.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between cards in parallel impossible. Do not rename it.
--
-- THE ANSWERS STILL OWED TO THE MODEL, AS AN INDEX (ASK-11).
--
-- An answer to a question whose asker is gone is marked `answerRelay:
-- 'queued'` on the question's tool call, inside the row's zstd-compressed
-- `tool_calls`/`blocks`, and stays owed until the turn that carries it has
-- started (`lib/answer-relay.ts`). A restart empties the relay's queue, and
-- the only way back to those marks was the boot's orphan sweep: thirty days
-- of finalized rows of topics not archived. A question never expires, so an
-- answer to an older one, or on a row still partial, or in an archived topic,
-- was never loaded again: the person's next message went to the model alone
-- and the row stayed `queued` for ever.
--
-- One row per owed answer, written in the same transaction as the `queued`
-- mark and deleted in the same transaction as the `sent` one. The boot reads
-- this table, not the messages: what it costs follows what is owed, not the
-- history.
--
--   tool_call_id  the question's tool call: the answer's identity.
--   session_key   the chat the answer goes to.
--   row_id        the message row carrying the tool call, where the mark and
--                 the answer are read back (`owedAnswerOf`).
--   created_at    epoch ms of the answer: the order a session's answers go in.
--
-- No foreign key on the row: a row gone takes its answer with it, and the
-- boot drops an entry whose row or mark it no longer finds.
--
-- Nothing to backfill here: the marks written before this table sit inside
-- compressed blobs SQL cannot read. The boot sweep indexes the ones it finds.
CREATE TABLE IF NOT EXISTS owed_answers (
  tool_call_id TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
