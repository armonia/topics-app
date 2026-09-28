-- 20260928203249-chat-forks.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: it is what
-- makes a collision between cards in parallel impossible. Do not rename it.
--
-- WHERE A FORKED CHAT CAME FROM (CHAT-FORK-01, card a298eb7b).
--
-- «Fork into a new chat» creates a topic whose history is a copy of the
-- original's active branch up to its last finished answer. One row per branch,
-- written in the same transaction as the topic and the copy:
--
--   parent_topic_id        the original. No foreign key: the original can go,
--                          the branch stays and its «Forked from» line only
--                          loses the link.
--   parent_name            the original's name at the fork, shown even when
--                          the original is gone.
--   fork_point_message_id  the branch's copy of the point: the row the
--                          «Forked from» divider sits under.
--   runtime                how the branch's model gets the history
--                          (shared/chat-fork.ts).
--   parent_ref             the original's CLI session (claude-cli) or thread
--                          (codex-cli). NULL = the copied history is the
--                          branch's only memory, and the state every branch
--                          reaches once the fork is consumed or impossible.
--   parent_at              claude-cli: the transcript uuid given to
--                          `--resume-session-at`; codex-cli: the byte size of
--                          the original's rollout at the fork.
--   branch_ref             claude-cli only: the session uuid the route minted
--                          for the branch. The fork runs while the branch's
--                          session IS this uuid, so a session forgotten by
--                          /clear, a worktree reap or a recovery never forks
--                          again.
--
-- Nothing to backfill: no chat was a branch before this table.
CREATE TABLE IF NOT EXISTS chat_forks (
  session_key            TEXT PRIMARY KEY,
  parent_topic_id        TEXT,
  parent_name            TEXT NOT NULL,
  fork_point_message_id  TEXT NOT NULL,
  runtime                TEXT NOT NULL CHECK (runtime IN ('claude-cli', 'codex-cli', 'db-history')),
  parent_ref             TEXT,
  parent_at              TEXT,
  branch_ref             TEXT,
  created_at             TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);
