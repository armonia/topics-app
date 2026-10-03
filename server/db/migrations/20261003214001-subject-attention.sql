-- 20261003214001-subject-attention.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- The attention state of every subject (a chat `topic:<id>`, a terminal
-- `terminal:<id>`, a board card `task:<id>`), composed on the server and
-- written by ONE module, `server/attention/store.ts` (openspec change
-- notifications-redesign, design section 2.1 and 11).
--
-- Schema only, no backfill: the first start after this migration lights only
-- what is true at that moment (open waits, cards in review or parked, live
-- processes), and chats that finished before the release stay dark. The row
-- keeps what nobody else remembers (the last turn, how far the person has
-- seen, the tasks in flight, the epoch and its cause); everything else is
-- re-read at every start from where it already lives.
CREATE TABLE IF NOT EXISTS subject_attention (
  subject      TEXT PRIMARY KEY,
  -- idle | working | background | needs-you | finished
  state        TEXT NOT NULL,
  -- needs-you: question | permission | plan | review | parked
  reason       TEXT,
  -- finished: done | error
  outcome      TEXT,
  -- one line: the question, the tool, the reason of the park, the error
  detail       TEXT,
  -- when the subject entered this state
  since        TEXT NOT NULL,
  -- grows at every new lit fact
  epoch        INTEGER NOT NULL DEFAULT 0,
  -- the fact that gave the current epoch: the same fact recomposed is no new epoch
  epoch_cause  TEXT,
  -- the last epoch the person has seen
  seen_epoch   INTEGER NOT NULL DEFAULT 0,
  -- JSON: { id, outcome: done|error, at, detail }
  last_turn    TEXT,
  -- how far the person has seen the subject's turns
  seen_at      TEXT,
  -- JSON: the tasks in flight, by id
  background   TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subject_attention_state ON subject_attention(state);
