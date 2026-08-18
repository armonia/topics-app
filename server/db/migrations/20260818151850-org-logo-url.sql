-- 20260818151850-org-logo-url.sql
--
-- Aggiunge il logo all'organizzazione.
--
-- Un SVG inline (data URI) o un path locale -- chi gestisce il dato decide.
-- NULL = nessun logo impostato: la UI mostra le iniziali come fallback.
-- Non c'e' CHECK sul formato: la validazione sta alla porta HTTP.

ALTER TABLE orgs ADD COLUMN logo_url TEXT;
