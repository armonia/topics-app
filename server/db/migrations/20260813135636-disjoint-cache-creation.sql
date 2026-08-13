-- Le quote di cache che il turno VIVO scriveva annidate, rimesse disgiunte.
--
-- ── COSA È SUCCESSO ─────────────────────────────────────────────────────────
-- La 070 ha dichiarato il contratto delle tre colonne: quote DISGIUNTE, cioè
-- `cache_creation_tokens` NON include `cache_creation_1h_tokens`, e
-- `usage_prompt_tokens = fresco + read + creation + creation_1h`. Il consuntivo
-- di fine turno lo rispettava (sottraeva l'1h dal totale prima di scrivere).
-- Il gestore del consumo VIVO no: copiava nei due campi i valori come li manda
-- l'API di Anthropic, dove `cache_creation_input_tokens` è il TOTALE e
-- `cache_creation.ephemeral_1h_input_tokens` una sua PARTE. Annidati, non
-- disgiunti.
--
-- Su questa macchina la CLI scrive in cache sempre a un'ora, quindi totale e
-- quota coincidono: le righe toccate hanno `cache_creation_tokens =
-- cache_creation_1h_tokens` e la stessa scrittura contata due volte.
--
-- ── PERCHÉ NON SI SONO RIPARATE DA SOLE ─────────────────────────────────────
-- Perché il consuntivo le avrebbe sovrascritte, ma solo se fosse arrivato. La
-- UPDATE usa COALESCE su ogni colonna (`server/utils.ts`), quindi quando il
-- turno muore prima del `result` — errore, stop, riavvio del server — le
-- variabili restano `undefined` e il valore VIVO resta. Al momento di scrivere
-- questa migration erano 360 righe, di cui la grande maggioranza già
-- finalizzate: righe ferme, che nessun turno futuro tocca più.
--
-- ── COSA SI RIPARA E COSA NO ────────────────────────────────────────────────
-- Si sottrae la quota a un'ora dal totale, che è l'inversa esatta dell'errore.
-- Tre cancelli tengono la UPDATE dentro il provabile:
--   • `cache_creation_1h_tokens > 0` — senza quota a un'ora non c'è niente da
--     scorporare e la riga è già disgiunta per definizione;
--   • `cache_creation_tokens >= cache_creation_1h_tokens` — la sottrazione non
--     può produrre un negativo. Le righe dove l'1h SUPERA il totale esistono in
--     teoria (arrotondamenti fra chiamate) e resterebbero incoerenti: ripararle
--     vorrebbe dire inventare un numero. Sul DB di produzione sono zero.
--   • la somma che SFORA il prompt — è la prova che la riga è annidata. Una
--     riga legittimamente disgiunta, anche con le due quote uguali per
--     coincidenza, ci sta dentro e non viene toccata.
--
-- NON si tocca `cost_cents`. Su queste righe è il costo VIVO congelato, e il
-- contatore di output durante lo streaming è un segnaposto: il prezzo è sotto
-- del valore dell'intera risposta. Quel numero non è ricostruibile — i token di
-- output veri non sono mai stati salvati — e riscriverlo con una stima
-- significherebbe sostituire un numero sbagliato riconoscibile con uno
-- sbagliato che sembra giusto. Da qui in avanti non ricapita: il consuntivo
-- ora risolve il modello anche quando l'evento `result` non lo porta.

UPDATE messages
   SET cache_creation_tokens = cache_creation_tokens - cache_creation_1h_tokens
 WHERE cache_creation_tokens    IS NOT NULL
   AND cache_creation_1h_tokens IS NOT NULL
   AND cache_creation_1h_tokens > 0
   AND cache_creation_tokens >= cache_creation_1h_tokens
   AND COALESCE(cache_read_tokens, 0) + cache_creation_tokens + cache_creation_1h_tokens
       > COALESCE(usage_prompt_tokens, 0);
