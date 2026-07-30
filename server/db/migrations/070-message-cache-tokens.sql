-- La quota di CACHE di ogni messaggio, che il server calcolava e buttava.
--
-- Migration 014 ha dato ai messaggi `usage_prompt_tokens`,
-- `usage_completion_tokens` e `cost_cents`: tre numeri aggregati. Il provider però
-- legge molto di più — `cache_read_input_tokens`, `cache_creation_input_tokens` e
-- `cache_creation.ephemeral_1h_input_tokens` (il TTL a un'ora, che costa 2×) — e in
-- `routes/chat.ts` quelle quote vengono usate SOLO per calcolare il costo, poi
-- scartate. Il risultato è che si vede quanto è costato un messaggio e non cosa
-- l'ha reso costoso: in un turno agentico lungo la cache riletta è la voce
-- schiacciante, e senza scorporarla il numero non insegna niente.
--
-- Il repo aveva già imparato questa lezione: migration 048 ha aggiunto
-- `agent_cache_read_tokens` ai TASK della board, col commento
-- «cache_read_input_tokens — the dominant share of real consumption». Quella
-- scoperta non è mai arrivata ai messaggi della chat. Queste colonne sono la
-- stessa cosa, per la stessa ragione, dall'altro lato dell'app.
--
-- NULL, non 0, come default: `usage_prompt_tokens` fa già così (014) e la
-- distinzione conta — 0 significa "misurato, nessuna cache", NULL significa "non
-- lo sappiamo" (messaggi vecchi, provider che non riporta l'usage, turni abortiti
-- prima del `result`). Un backfill a zero renderebbe indistinguibili le due cose e
-- farebbe sembrare che milioni di token di cache non siano mai esistiti.
--
-- Quote DISGIUNTE, non annidate: `cache_creation_tokens` NON include
-- `cache_creation_1h_tokens`. È la stessa convenzione di `usage/pricing.ts`
-- (`cacheCreation1hTokens` è «quota DISGIUNTA da cacheCreationTokens — sommarle
-- sarebbe contarle due volte»), e tenerla identica evita che il consumatore debba
-- ricordare da quale lato dell'app viene il numero.

ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cache_creation_1h_tokens INTEGER;
