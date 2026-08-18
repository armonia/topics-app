-- 20260818152057-armonia-bootstrap.sql
--
-- Bootstrap dell'organizzazione Armonia.
--
-- Rinomina l'organizzazione di questa installazione in «Armonia» (se esiste e
-- si chiama ancora «La mia organizzazione» o non ha mai avuto un nome proprio)
-- e imposta il logo SVG inline.
--
-- L'email della persona proprietaria viene impostata SOLO se era NULL: non si
-- sovrascrive un indirizzo che qualcuno ha gia' scelto.
--
-- Questa migration NON crea nessuna riga nuova: usa quelle create dalla 084.
-- Se un'installazione e' gia' stata rinominata, l'UPDATE non tocca niente
-- (WHERE name = 'La mia organizzazione'). E' idempotente.

-- Imposta il nome e il logo dell'organizzazione principale.
UPDATE orgs
   SET name = 'Armonia',
       logo_url = '/org-armonia.svg',
       rev = rev + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE id = (
   SELECT org_id FROM installation WHERE singleton = 1
 )
   AND (name = 'La mia organizzazione' OR name = 'Armonia');

-- Imposta l'email del proprietario dell'installazione se non ne ha una.
UPDATE people
   SET email = 'redatto@example.com',
       rev = rev + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE id = (
   SELECT person_id FROM installation_owners WHERE is_default = 1
 )
   AND email IS NULL;
