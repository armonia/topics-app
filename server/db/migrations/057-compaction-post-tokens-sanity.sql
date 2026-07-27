-- Drop implausible post-compaction token counts.
--
-- `post_tokens` used to be backfilled from the final `result` usage, which the
-- Claude CLI reports as an AGGREGATE over every model call in the turn — not as
-- a context size. On the long turns that actually trigger a compaction that sum
-- dwarfs the real context, so the divider rendered nonsense like
-- "167k -> 11.2M token", i.e. the context appearing to EXPLODE during a
-- compaction. The size is now measured from the first single call after the
-- boundary (StreamHandler.onContextSize).
--
-- A compaction always SHRINKS the context, so any row with post >= pre is a
-- known-bad reading: null it out. The divider then falls back to its
-- "~<pre> token prima" form — honest, instead of confidently wrong.
UPDATE compaction_markers
   SET post_tokens = NULL
 WHERE post_tokens IS NOT NULL
   AND pre_tokens IS NOT NULL
   AND post_tokens >= pre_tokens;
