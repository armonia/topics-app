-- The 5.5 history, repriced at the official prices.
--
-- Until 24/10/2026 the price table had no 5.5 rows: Opus 5.5 was billed as
-- Opus 5 ($5/$25), Sonnet 5.5 and Sonnet 5 at $3/$15, Fable and Mythos 5.1 as
-- Fable 5 (cache read at 0.1x), Haiku 5.5 as Haiku 4.5 ($1/$5). The real prices
-- are Opus 5.5 $4/$20 with cache reads at 0.05x, Sonnet 5.5 $2/$10 at 0.05x,
-- Sonnet 5 $2/$10, Fable and Mythos 5.1 $10/$50 at 0.025x, Haiku 5.5 $0.10/$0.50
-- ($0.50/$2.50 for a request over 100k tokens of prompt). Cache writes are 1.25x
-- (5 minutes) and 2x (one hour) on every model, and output is 5x input on all of
-- these rows, before and after.
--
-- WHICH ROWS. Every row of those models with the cache split measured
-- (`cache_read_tokens` not null) whose stored cost IS the old table's price of
-- its own tokens, within one cent of rounding. A row whose cost came from
-- somewhere else (a provider's own figure) does not match and is left alone.
-- On the live DB of 24/10: 2,063 of 2,078 rows match.
--
-- THE OLD VALUE STAYS, in `cost_cents_before_reprice`. To go back:
--   UPDATE messages SET cost_cents = cost_cents_before_reprice, cost_estimated = NULL
--    WHERE cost_cents_before_reprice IS NOT NULL;
-- (the per-tool costs were scaled by cost_cents / cost_cents_before_reprice).
--
-- HAIKU 5.5 IS AN ESTIMATE. Its rate card is chosen per request, and a row holds
-- the sum of a whole turn's calls: the calls are gone. A turn whose total prompt
-- is at most 100k tokens had every call under the threshold, and is exact. Over
-- 100k the row is priced as if every call were over it, which is an upper bound,
-- and `cost_estimated = 1` says so: the usage panel shows those dollars as
-- estimated.

ALTER TABLE messages ADD COLUMN cost_cents_before_reprice INTEGER;
ALTER TABLE messages ADD COLUMN cost_estimated INTEGER;

-- 1. The rows, with their old and new price in cents. The input-equivalent
-- units of a row are fresh x1, cache read x(rate), 5m write x1.25, 1h write x2,
-- output x5; cents = units x input price / 10,000.
CREATE TEMP TABLE _reprice AS
SELECT id, old_cents, new_cents, estimated
FROM (
  SELECT
    id,
    cost_cents AS old_cents,
    (fresh + rd * 0.1 + w5 * 1.25 + w1h * 2.0 + completion * 5.0) * old_in / 10000.0 AS old_expected,
    (fresh + rd * new_read + w5 * 1.25 + w1h * 2.0 + completion * 5.0) * new_in / 10000.0 AS new_cents,
    CASE WHEN fam = 'haiku55' AND prompt > 100000 THEN 1 ELSE 0 END AS estimated
  FROM (
    SELECT
      id, cost_cents, fam, prompt, fresh, rd, w5, w1h, completion,
      CASE fam WHEN 'opus55' THEN 5.0 WHEN 'sonnet55' THEN 3.0 WHEN 'sonnet5' THEN 3.0
               WHEN 'haiku55' THEN 1.0 WHEN 'fable51' THEN 10.0 END AS old_in,
      CASE fam WHEN 'opus55' THEN 4.0 WHEN 'sonnet55' THEN 2.0 WHEN 'sonnet5' THEN 2.0
               WHEN 'haiku55' THEN (CASE WHEN prompt > 100000 THEN 0.5 ELSE 0.1 END)
               WHEN 'fable51' THEN 10.0 END AS new_in,
      CASE fam WHEN 'opus55' THEN 0.05 WHEN 'sonnet55' THEN 0.05 WHEN 'sonnet5' THEN 0.1
               WHEN 'haiku55' THEN 0.1 WHEN 'fable51' THEN 0.025 END AS new_read
    FROM (
      SELECT
        id,
        cost_cents,
        usage_prompt_tokens AS prompt,
        MAX(0, usage_prompt_tokens
              - COALESCE(cache_read_tokens, 0)
              - COALESCE(cache_creation_tokens, 0)
              - COALESCE(cache_creation_1h_tokens, 0)) AS fresh,
        COALESCE(cache_read_tokens, 0) AS rd,
        COALESCE(cache_creation_tokens, 0) AS w5,
        COALESCE(cache_creation_1h_tokens, 0) AS w1h,
        COALESCE(usage_completion_tokens, 0) AS completion,
        -- `GLOB` is case-sensitive and the ids are written lowercase. Sonnet 5
        -- is matched exactly (bare, with a window suffix, or dated): a prefix
        -- would swallow Sonnet 5.5.
        CASE
          WHEN model GLOB 'claude-opus-5-5*' THEN 'opus55'
          WHEN model GLOB 'claude-sonnet-5-5*' THEN 'sonnet55'
          WHEN model = 'claude-sonnet-5'
            OR model GLOB 'claude-sonnet-5[[]*'
            OR model GLOB 'claude-sonnet-5-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*' THEN 'sonnet5'
          WHEN model GLOB 'claude-haiku-5-5*' THEN 'haiku55'
          WHEN model GLOB 'claude-fable-5-1*' OR model GLOB 'claude-mythos-5-1*' THEN 'fable51'
        END AS fam
      FROM messages
      WHERE cost_cents > 0
        AND usage_prompt_tokens > 0
        AND cache_read_tokens IS NOT NULL
        AND model IS NOT NULL
    )
    WHERE fam IS NOT NULL
  )
)
WHERE ABS(old_cents - ROUND(old_expected)) <= 1;

-- 2. The message cost, with the old value kept beside it. Never below one cent:
-- zero reads as "not measured" in the chip, which these rows were.
UPDATE messages
SET cost_cents_before_reprice = cost_cents,
    cost_cents = MAX(1, CAST(ROUND((SELECT new_cents FROM _reprice r WHERE r.id = messages.id)) AS INTEGER)),
    cost_estimated = CASE WHEN (SELECT estimated FROM _reprice r WHERE r.id = messages.id) = 1 THEN 1 ELSE NULL END
WHERE id IN (SELECT id FROM _reprice);

-- 3. The per-tool costs inside the two JSON columns, scaled by the message's
-- ratio so the tools still add up under the new total. Each one is truncated to
-- whole cents, never rounded up or floored at one: tools that sum to the old
-- total then sum to at most the new one (six 1-cent tools in a 6 cent turn
-- repriced to 4 would otherwise add up to 6). Same pattern as 077:
-- `json_group_array(json(value))` keeps the objects as objects.
UPDATE messages
SET tool_calls = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.costCents') IS NOT NULL
      THEN json_set(value, '$.costCents',
             CAST(json_extract(value, '$.costCents') * 1.0 * messages.cost_cents
                   / messages.cost_cents_before_reprice AS INTEGER))
      ELSE value END))
  FROM json_each(messages.tool_calls))
WHERE id IN (SELECT id FROM _reprice)
  AND tool_calls IS NOT NULL
  AND json_valid(tool_calls)
  AND json_type(tool_calls) = 'array'
  AND tool_calls LIKE '%costCents%';

UPDATE messages
SET blocks = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.toolCall.costCents') IS NOT NULL
      THEN json_set(value, '$.toolCall.costCents',
             CAST(json_extract(value, '$.toolCall.costCents') * 1.0 * messages.cost_cents
                   / messages.cost_cents_before_reprice AS INTEGER))
      ELSE value END))
  FROM json_each(messages.blocks))
WHERE id IN (SELECT id FROM _reprice)
  AND blocks IS NOT NULL
  AND json_valid(blocks)
  AND json_type(blocks) = 'array'
  AND blocks LIKE '%costCents%';

DROP TABLE _reprice;
