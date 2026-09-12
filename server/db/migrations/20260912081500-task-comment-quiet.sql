-- A comment can be a NOTE instead of a reply, and until now nothing remembered which.
--
-- `POST /tasks/:id/comments` already accepts `quiet: true` — the gesture that
-- says «I am annotating, I am not answering» — but it only used it to return
-- early, so the stored row came out identical to a real reply. That mattered
-- one surface further along: `pendingQuestionComment` walks the thread
-- backwards and stops at the first human word, so a quiet note posted under an
-- open question took that question's option buttons away.
--
-- NULL is the history written before the column existed, and it must read as
-- «not quiet»: treating the unknown as quiet would silently revive questions
-- that a real answer had closed.
ALTER TABLE task_comments ADD COLUMN quiet INTEGER
  CHECK (quiet IN (0, 1)) DEFAULT NULL;
