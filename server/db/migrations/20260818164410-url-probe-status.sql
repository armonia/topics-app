-- 20260818164410-url-probe-status.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Aggiunge l'esito della sonda sull'output_url del task (live/dead/unknown).
-- La sonda gira lato server con cache TTL; il client mostra o nasconde il link
-- in base a questo campo. Tre stati distinti: live, dead, unknown (mai provata).
ALTER TABLE tasks ADD COLUMN url_probe_status TEXT
  CHECK (url_probe_status IN ('live', 'dead', 'unknown'))
  DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN url_probe_checked_at TEXT DEFAULT NULL;
