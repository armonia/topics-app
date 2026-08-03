-- Le sessioni già appuntate a un modello restavano sui 200k.
--
-- La finestra da un milione, sulla CLI, non è una dotazione del modello: è una
-- MODALITÀ, servita col beta `context-1m-2025-08-07` ed esposta come un id a
-- parte (`claude-opus-5[1m]` accanto a `claude-opus-5`). Un id nudo è da 200k
-- anche sulla generazione 5 — misurato il 3 agosto 2026 sulla CLI 2.1.220 con
-- lo stesso prompt da ~250k token: `claude-opus-5` risponde «Prompt is too
-- long», `claude-opus-5[1m]` risponde e basta.
--
-- Il default è passato al milione (`defaultChatModel()` in
-- `server/providers/claude-code.ts`), ma il default vale solo per chi NON ha
-- scelto: i topic con un modello scritto in colonna sarebbero rimasti a 200k
-- per sempre, e in silenzio — il selettore mostra «Opus 4.8», che è vero, e non
-- dice quanta finestra sia. Quindi si sposta il pin sul gemello `[1m]`: stesso
-- modello, stessa generazione, solo la finestra grande.
--
-- QUALI famiglie. Solo opus e sonnet: il beta non copre tutto. `claude-haiku-4-5[1m]`
-- risponde 400 «The long context beta is not yet available for this
-- subscription» — a turno già partito, cioè un errore in faccia all'umano — e
-- fable il milione ce l'ha già di suo, nudo. Le righe non-Claude (`gpt-*`) non
-- si toccano: il suffisso è una convenzione della CLI di Anthropic e altrove non
-- vuol dire niente.
--
-- QUALI righe. I PIN, cioè le scelte valide da qui in avanti: `topics.model` e
-- `tasks.model` dei task ancora aperti. Non si tocca niente di STORICO —
-- `messages.model`, `usage_records.model`, `session_context.model` e il modello
-- dei task già chiusi registrano cosa è girato davvero, e riscriverli sarebbe
-- una bugia sul passato. `session_context.window_tokens` resta com'è di
-- proposito: `windowForMeasure()` ricalcola il denominatore dal modello del
-- topic a ogni lettura, quindi la riga vecchia si corregge da sé.

UPDATE topics
SET model = model || '[1m]'
WHERE model IS NOT NULL
  AND model NOT LIKE '%[1m]'
  AND (model LIKE 'claude-opus-%' OR model LIKE 'claude-sonnet-%');

UPDATE tasks
SET model = model || '[1m]'
WHERE model IS NOT NULL
  AND model NOT LIKE '%[1m]'
  AND status <> 'done'
  AND (model LIKE 'claude-opus-%' OR model LIKE 'claude-sonnet-%');
