-- 20260906115131-machine-base-url.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations

--
-- Where a paired node ANSWERS: the HTTPS base URL this machine calls to mirror
-- a card onto it. NULL for the local row, which is nobody's node.
--
-- The credential is NOT here on purpose: the token lives in a 0600 file under
-- the state dir, and this row is served to the client as it is (MACHINE-02).

ALTER TABLE machines ADD COLUMN base_url TEXT;
