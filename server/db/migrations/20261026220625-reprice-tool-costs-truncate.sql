-- The per-tool costs of the 5.5 reprice, brought back under the message total.
--
-- 20261024180000-reprice-5-5-history scaled each tool's `costCents` by the
-- message's ratio (new cost / old cost), ROUNDED and floored at one cent. On a
-- turn of many cheap tools that adds up to more than the message: six 1-cent
-- tools in a 6 cent turn repriced to 4 stay six 1-cent tools, 6 cents of tools
-- in a 4 cent message. That migration is already applied (production, 24/10),
-- so it is corrected here and not edited.
--
-- The tools' costs before the reprice are gone (the old migration overwrote
-- them), so the truncated value cannot be recomputed from them. What this does
-- instead: on every repriced row (`cost_cents_before_reprice` not null) whose
-- tools add up to MORE than `cost_cents`, each tool is scaled by
-- cost_cents / (sum of the tools) and truncated to whole cents. The truncated
-- parts add up to at most `cost_cents`. A row whose tools already fit is left
-- alone, so a second run finds nothing to change: idempotent.
--
-- `tool_calls` and `blocks` are corrected each on its own sum. Same JSON
-- pattern as 077 and the reprice: `json_group_array(json(value))` keeps the
-- objects as objects, entries without a cost are copied as they are.

UPDATE messages
SET tool_calls = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.costCents') IS NOT NULL
      THEN json_set(value, '$.costCents',
             CAST(json_extract(value, '$.costCents') * 1.0 * messages.cost_cents
                  / (SELECT SUM(json_extract(t.value, '$.costCents')) FROM json_each(messages.tool_calls) t)
                  AS INTEGER))
      ELSE value END))
  FROM json_each(messages.tool_calls))
WHERE cost_cents_before_reprice IS NOT NULL
  AND cost_cents > 0
  AND tool_calls IS NOT NULL
  AND json_valid(tool_calls)
  AND json_type(tool_calls) = 'array'
  AND tool_calls LIKE '%costCents%'
  AND (SELECT SUM(json_extract(t.value, '$.costCents')) FROM json_each(messages.tool_calls) t) > cost_cents;

UPDATE messages
SET blocks = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.toolCall.costCents') IS NOT NULL
      THEN json_set(value, '$.toolCall.costCents',
             CAST(json_extract(value, '$.toolCall.costCents') * 1.0 * messages.cost_cents
                  / (SELECT SUM(json_extract(b.value, '$.toolCall.costCents')) FROM json_each(messages.blocks) b)
                  AS INTEGER))
      ELSE value END))
  FROM json_each(messages.blocks))
WHERE cost_cents_before_reprice IS NOT NULL
  AND cost_cents > 0
  AND blocks IS NOT NULL
  AND json_valid(blocks)
  AND json_type(blocks) = 'array'
  AND blocks LIKE '%costCents%'
  AND (SELECT SUM(json_extract(b.value, '$.toolCall.costCents')) FROM json_each(messages.blocks) b) > cost_cents;
