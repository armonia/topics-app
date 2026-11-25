-- 20261117150000-person-identities.sql
--
-- Chi ha scritto davvero un messaggio arrivato da un canale esterno (WhatsApp, Discord…).
-- I turni dei canali entrano da loopback e senza questa tabella ogni messaggio risultava
-- del proprietario: il mittente vero stava solo dentro il testo. Una riga lega l'id che il
-- canale dà a una persona (`people`), creata la prima volta che quel mittente scrive.
CREATE TABLE IF NOT EXISTS person_identities (
  channel     TEXT NOT NULL,
  external_id TEXT NOT NULL,
  person_id   TEXT NOT NULL REFERENCES people(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_person_identities_person ON person_identities(person_id);

-- Le chiamate fatte fuori dal motore nativo (sandbox dei canali) arrivano con il loro autore.
ALTER TABLE usage_records ADD COLUMN author_person_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_author ON usage_records(author_person_id, timestamp)
  WHERE author_person_id IS NOT NULL;
-- Cosa ha fatto la chiamata in parole del chiamante (es. il nome del turno), facoltativo.
ALTER TABLE usage_records ADD COLUMN label TEXT;
