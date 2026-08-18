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

-- L'EMAIL DEL PROPRIETARIO NON STA QUI, e non e' una svista.
--
-- Questa migration conteneva un `UPDATE people SET email = '<indirizzo di una
-- persona reale>' WHERE email IS NULL`. Due cose sbagliate insieme:
--
--  · l'indirizzo privato di un individuo finiva in un file TRACCIATO di un repo
--    PUBBLICO. Il cancello `no-personal-data-tracked` non poteva vederlo:
--    protegge l'identita' di CHI COMMITTA, derivandola a runtime, e un terzo
--    non e' derivabile. Ora c'e' anche `no-third-party-emails`;
--  · e su ogni installazione NUOVA — dove il proprietario nasce senza email —
--    quell'indirizzo veniva stampato addosso a un utente che non c'entra
--    niente. Su questa macchina non e' successo solo perche' un'email c'era
--    gia'; l'ha scoperto la suite E2E, dove il database nasce vuoto.
--
-- L'email di una persona la scrive quella persona, dalle impostazioni.
