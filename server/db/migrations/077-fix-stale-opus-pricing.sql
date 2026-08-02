-- Il costo dei messaggi Opus era il TRIPLO del vero.
--
-- `server/usage/pricing.ts` non conteneva nessun modello in uso: ogni id reale
-- cadeva nel ripiego di famiglia, che puntava al modello più vecchio — 15$/75$
-- per milione invece dei 5$/25$ veri. L'errore è un fattore moltiplicativo
-- COMUNE a input e output (15/5 = 75/25 = 3), quindi la correzione è una
-- divisione esatta, non una stima.
--
-- QUALI righe. Il modello non è salvato (la colonna arriva con la 076, senza
-- backfill), ma il prezzo APPLICATO è ricavabile: si pesano le quote in
-- input-equivalenti — fresco ×1, rilettura ×0,1, scrittura ×1,25, scrittura a
-- un'ora ×2, risposta ×5 (il rapporto output/input è 5 su tutta la famiglia
-- Claude) — e si divide il costo per quelle unità. Misurato sul DB di prod, il
-- risultato non è una nuvola: si addensa su 15,00 e su 0,80, cioè esattamente
-- le due tariffe stantie della tabella. Le righe che non cadono su un valore
-- noto NON si toccano: sono quelle il cui costo arrivava dal provider
-- (`total_cost_usd`), che è già giusto.
--
-- SOLO le righe post-070, cioè quelle con lo scorporo della cache misurato.
-- Nelle righe precedenti la cache non era nemmeno separata dall'input fresco: il
-- loro costo è sbagliato anche di un secondo fattore, ignoto, che vale fino a
-- ~10× — e un fattore ignoto non si corregge. Restano com'erano; è la dashboard
-- che smette di sommarle come se fossero denaro (vedi `server/routes/dashboard.ts`).
--
-- Anche i costi PER TOOL, che vivono dentro `tool_calls` e `blocks`, passano
-- dallo stesso calcolo: correggere solo l'intestazione lascerebbe le righe dei
-- tool a sommare il triplo del totale che le sovrasta.

-- ── 1. Le righe da correggere, con il loro fattore ────────────────────────────
-- Le due finestre sono STRETTE di proposito: 15,00 ± 0,30 e 0,80 ± 0,05, cioè
-- ±2% e ±6%. Servono solo ad assorbire l'arrotondamento di `cost_cents`, che è
-- un intero; sui dati veri il prezzo dedotto si addensa entro ±0,06 dal valore
-- nominale. Largo abbastanza da non perdere righe, stretto abbastanza da non
-- inghiottirne una tariffata a 14$ o a 16$ da un'altra tabella.
CREATE TEMP TABLE _fix_pricing AS
SELECT
  id,
  CASE WHEN ABS(implied - 15.0) <= 0.30 THEN 3.0           -- Opus: 15$ → 5$
       ELSE 0.8                                            -- Haiku: 0,80$ → 1,00$
  END AS divisore
FROM (
  SELECT
    id,
    (cost_cents / 100.0) / (units / 1000000.0) AS implied
  FROM (
    SELECT
      id,
      cost_cents,
      MAX(0, usage_prompt_tokens
            - COALESCE(cache_read_tokens, 0)
            - COALESCE(cache_creation_tokens, 0)
            - COALESCE(cache_creation_1h_tokens, 0)) * 1.0
        + COALESCE(cache_read_tokens, 0) * 0.1
        + COALESCE(cache_creation_tokens, 0) * 1.25
        + COALESCE(cache_creation_1h_tokens, 0) * 2.0
        + COALESCE(usage_completion_tokens, 0) * 5.0 AS units
    FROM messages
    WHERE cost_cents > 0
      AND usage_prompt_tokens > 0
      -- post-070: lo scorporo della cache è MISURATO, quindi l'unico errore
      -- residuo è il prezzo.
      AND cache_read_tokens IS NOT NULL
  )
  WHERE units > 0
)
WHERE ABS(implied - 15.0) <= MAX((0.5 / 100.0) / 1.0, 0.30)
   OR ABS(implied - 0.80) <= 0.05;

-- ── 2. Il costo del messaggio ────────────────────────────────────────────────
UPDATE messages
SET cost_cents = MAX(1, CAST(ROUND(cost_cents / (SELECT divisore FROM _fix_pricing f WHERE f.id = messages.id)) AS INTEGER))
WHERE id IN (SELECT id FROM _fix_pricing);

-- ── 3. I costi per TOOL, dentro i due JSON che li portano ────────────────────
-- `json_group_array(json(value))` e non `json_group_array(value)`: il secondo
-- ri-quoterebbe ogni oggetto come stringa, trasformando l'array di tool in un
-- array di testo. Le righe senza `costCents` passano invariate.
UPDATE messages
SET tool_calls = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.costCents') IS NOT NULL
      THEN json_set(value, '$.costCents',
             MAX(1, CAST(ROUND(json_extract(value, '$.costCents')
                   / (SELECT divisore FROM _fix_pricing f WHERE f.id = messages.id)) AS INTEGER)))
      ELSE value END))
  FROM json_each(messages.tool_calls))
WHERE id IN (SELECT id FROM _fix_pricing)
  AND tool_calls IS NOT NULL
  AND json_valid(tool_calls)
  AND json_type(tool_calls) = 'array'
  AND tool_calls LIKE '%costCents%';

UPDATE messages
SET blocks = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(value, '$.toolCall.costCents') IS NOT NULL
      THEN json_set(value, '$.toolCall.costCents',
             MAX(1, CAST(ROUND(json_extract(value, '$.toolCall.costCents')
                   / (SELECT divisore FROM _fix_pricing f WHERE f.id = messages.id)) AS INTEGER)))
      ELSE value END))
  FROM json_each(messages.blocks))
WHERE id IN (SELECT id FROM _fix_pricing)
  AND blocks IS NOT NULL
  AND json_valid(blocks)
  AND json_type(blocks) = 'array'
  AND blocks LIKE '%costCents%';

DROP TABLE _fix_pricing;
