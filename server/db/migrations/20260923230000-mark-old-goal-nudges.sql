-- 20260923230000-mark-old-goal-nudges.sql
--
-- THE GOAL CONTINUATIONS WRITTEN BEFORE THEY WERE MARKED.
--
-- `server/lib/user-row-marks.ts` stamps `[{"kind":"goal-nudge",...}]` on the
-- `user` row the goal loop sends to keep an objective alive, so the chat draws
-- one service line instead of the person saying «Objective still open: ...».
-- Six rows of 4-5 September reached the table with a NULL `blocks` (a resend
-- path that did not carry the mark yet) and are still drawn as the person's
-- own bubble, with an edit button on words they never wrote.
--
-- Same guards as `20260904190854-mark-dispatched-envelopes.sql`:
--   * anchored at the START of the content: a person quoting the phrase in the
--     middle of a sentence is saying something;
--   * `role = 'user'` only;
--   * `blocks IS NULL` only, so a row that already carries marks keeps them.
-- The attempt number is not recoverable from the text, so it is written as 1:
-- the line reads «continuo (1)», which is what the first of each run was.

UPDATE messages SET blocks = '[{"kind":"goal-nudge","attempt":1}]'
WHERE role = 'user' AND blocks IS NULL AND content LIKE 'Objective still open: %';
