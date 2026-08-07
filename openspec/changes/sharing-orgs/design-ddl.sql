-- server/db/migrations/084-people-orgs.sql
--
-- Il SOGGETTO smette di essere il ferro.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COSA CAMBIA E COSA NO, detto prima del DDL perché è la parte che si rilegge.
--
-- La 083 ha scritto: «NESSUNA gerarchia implicita nella lettura. Il permesso si
-- MATERIALIZZA in righe quando lo si concede, e la verifica resta una SELECT su
-- una riga.» Quella regola VALE, e resta intatta, sull'asse RISORSA: progetto →
-- task continua a materializzarsi con via_type/via_id. Non vale sull'asse
-- SOGGETTO, e le tre ragioni sono verificabili invece che opinabili:
--
--   1. PROFONDITÀ. Progetto→task cresce (task figli, worktree, board). Qui è
--      FISSA a 2 e chiusa da questo file: non c'è `orgs.parent_id` e non ci
--      sarà. Un cammino di lunghezza fissa non è un grafo da girare, è una JOIN.
--      L'aciclicità non è un controllo a runtime, è una conseguenza dei tipi:
--      i due soli salti vanno device→person→org e non esiste un salto che scenda.
--   2. LA DOMANDA INVERSA. «Chi vede questa cosa?» resta la stessa SELECT su
--      `idx_grants_resource`. L'ESPANSIONE (org → persone → dispositivi) esiste,
--      è a due seek, e vive in `subjectsOf()` — una funzione sola, misurata, non
--      una risalita improvvisata nel primo punto che ne ha bisogno.
--   3. IL VERSO DELLA DIVERGENZA. Materializzare device→persona→org vuol dire
--      copiare righe a ogni pairing e a ogni nuovo membro, e il momento in cui
--      salta è un job che non è girato. Qui non c'è nessuna tabella derivata.
--
-- IL TETTO DUE È LA CONDIZIONE DI VALIDITÀ DI TUTTO QUESTO, non un default. Il
-- giorno che qualcuno aggiunge `orgs.parent_id` questo argomento CADE e il conto
-- va rifatto da capo — non esteso. `tests/unit/no-org-nesting.test.ts` fallisce
-- se quella colonna compare, ed è l'unico allarme che questa decisione avrà.
--
-- L'ALTRA DECISIONE, e va letta come una regola di prodotto e non di schema:
-- L'APPARTENENZA A UN'ORGANIZZAZIONE NON CONFERISCE ACCESSO A QUESTA MACCHINA.
-- Il proprietario è una persona in `installation_owners`, tabella LOCALE che la
-- sincronizzazione non tocca MAI. Un collega dello stesso team che apre il mio
-- :3333 è un ospite: è il mio filesystem, i miei terminali, il mio abbonamento.
-- L'organizzazione serve a tre cose e a nessun'altra: la licenza, la rubrica dei
-- destinatari, e l'essere un destinatario PLURALE di una concessione. Se il
-- ruolo dipendesse da `org_members` — che il piano di controllo possiederà — una
-- carta rifiutata chiuderebbe il proprietario fuori da casa sua, e un admin del
-- pannello potrebbe promuovere un estraneo a padrone della macchina di un altro.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. LE PERSONE.
--
-- `revoked_at` E NON UN DELETE, come in 080 e per la stessa ragione: una riga
-- cancellata non racconta niente, e in un merge è indistinguibile da una riga
-- mai vista. Ed è LETTA: `server/lib/principals.ts` la filtra in entrambi i
-- salti, con un test dedicato. Una colonna che sembra un interruttore di
-- sicurezza e non è cablata a niente è peggio della sua assenza.
--
-- `origin`/`remote_id`/`rev`/`updated_at`/`synced_at` ci sono ORA, e oggi valgono
-- sempre 'local'/NULL/0. Costano tre colonne adesso e risparmiano un ALTER su
-- tabelle piene mentre si scrive un client di sincronizzazione, cioè nel momento
-- peggiore possibile.
CREATE TABLE IF NOT EXISTS people (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  -- Come si INVITA qualcuno che non ha ancora appaiato niente. Oggi «invitare»
  -- significa aspettare che il telefono altrui faccia pairing e POI sceglierlo
  -- da una lista: l'ordine è rovesciato rispetto a come il prodotto si vende.
  email        TEXT,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  origin       TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','cloud')),
  remote_id    TEXT,
  rev          INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  synced_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email  ON people(email)     WHERE email     IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_remote ON people(remote_id) WHERE remote_id IS NOT NULL;

-- ── 2. LE ORGANIZZAZIONI.
--
-- NESSUN `parent_id`: vedi sopra, è l'invariante. NESSUN `kind`: un'«org
-- personale» è semplicemente un'org con un membro solo, e un enum che dice
-- 'personal' su una riga con dodici membri è uno stato che non significa niente.
-- Il singolo non deve MAI vedere la parola «organizzazione» nell'interfaccia:
-- è una regola di prodotto, non un campo.
CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  origin     TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','cloud')),
  remote_id  TEXT,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  synced_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_remote ON orgs(remote_id) WHERE remote_id IS NOT NULL;

-- ── 3. L'APPARTENENZA. Piatta e multipla: una persona sta in N organizzazioni
-- (il consulente è proprietario della sua e ospite di tre altre); nessuna
-- organizzazione sta dentro un'altra. È il secondo e ULTIMO salto.
CREATE TABLE IF NOT EXISTS org_members (
  org_id     TEXT NOT NULL REFERENCES orgs(id)   ON DELETE RESTRICT,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  -- Ruolo DENTRO l'organizzazione: decide chi può scrivere in questa tabella
  -- (invitare, rimuovere). NON è il ruolo d'accesso a questa installazione —
  -- quello lo decide `installation_owners` e nient'altro. È l'unico uso di
  -- questa colonna, ed è imposto in `server/routes/orgs.ts`: se un giorno
  -- nessuno la legge più, va tolta invece che lasciata a suggerire un potere
  -- che non ha.
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at        INTEGER NOT NULL,
  -- Tombstone dell'appartenenza. Chi la scrive è il piano di controllo, quando
  -- esisterà: è la licenza.
  revoked_at       INTEGER,
  -- LA LEVA LOCALE, e la sincronizzazione non la tocca MAI.
  --
  -- Senza di essa la revoca offline è ineseguibile: `org_members` è replica ad
  -- autorità remota, quindi una rimozione fatta qui verrebbe RIPRISTINATA dal
  -- primo pull, in silenzio. Licenzi qualcuno il venerdì con il Mac staccato
  -- dalla rete e la tua revoca si annulla da sola lunedì. Questa colonna è
  -- l'unico posto in cui una decisione presa qui sopravvive al ritorno della
  -- rete, ed è letta dal risolutore accanto a `revoked_at`.
  local_blocked_at INTEGER,
  rev              INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (org_id, person_id)
);
-- L'indice del secondo salto: persona → le sue organizzazioni. In questo verso
-- perché è sempre la domanda calda.
CREATE INDEX IF NOT EXISTS idx_org_members_person ON org_members(person_id);

-- ── 4. CHI POSSIEDE QUESTA MACCHINA. Tabella LOCALE, `origin` non esiste
-- apposta: non c'è niente da sincronizzare qui, e non deve esserci.
--
-- Plurale, perché due persone possono usare lo stesso Mac. `is_default` marca
-- quella a cui si attribuisce un'azione fatta da loopback, dove non c'è modo di
-- sapere chi ha le mani sulla tastiera.
CREATE TABLE IF NOT EXISTS installation_owners (
  person_id  TEXT PRIMARY KEY REFERENCES people(id) ON DELETE RESTRICT,
  added_at   INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_install_owner_default
  ON installation_owners(is_default) WHERE is_default = 1;

-- ── 5. A QUALE ORGANIZZAZIONE APPARTIENE QUESTA INSTALLAZIONE.
-- Serve alla licenza e alla RUBRICA («le persone della mia org» è una lista
-- chiusa e potabile, `people` intera non lo è). NON decide il ruolo di nessuno.
CREATE TABLE IF NOT EXISTS installation (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

-- ── 6. IL DISPOSITIVO RESTA IL CREDENZIALE, LA PERSONA DIVENTA IL SOGGETTO.
-- ADD COLUMN è istantaneo e non riscrive la tabella: nessun `token_hash` viene
-- toccato, quindi nessuna sessione viva si rompe.
--
-- `person_id` NULL significa UNA cosa sola e va detta qui perché il codice ci si
-- appoggia: dispositivo senza persona ⇒ CONFINATO. Non è «legacy», non è «da
-- decidere»: è il fallback prudente. Il backfill qui sotto riempie tutte le
-- righe esistenti, e `server/routes/auth.ts` (pairing) riempirà le nuove; un
-- NULL residuo è quindi una riga scritta fuori dalle rotte, e per quella il
-- verso giusto è consegnare meno.
ALTER TABLE devices ADD COLUMN person_id TEXT REFERENCES people(id);
CREATE INDEX IF NOT EXISTS idx_devices_person ON devices(person_id);

-- ── 7. IL CONTATORE DI VERSIONE DEI PRINCIPALI.
--
-- Sta in TABELLA e lo incrementano dei TRIGGER, non un intero in memoria. La
-- ragione è precisa: chi cambia l'appartenenza è il sincronizzatore, cioè
-- proprio la cosa che porta la revoca, e può girare in un altro processo o
-- essere un `sqlite3` a mano. Un contatore in RAM non lo vedrebbe, e una socket
-- WebSocket già aperta conserverebbe i principali di prima finché non
-- riconnette. In tabella lo vede chiunque.
CREATE TABLE IF NOT EXISTS principals_rev (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  rev       INTEGER NOT NULL
);
INSERT OR IGNORE INTO principals_rev (singleton, rev) VALUES (1, 1);

CREATE TRIGGER IF NOT EXISTS trg_prev_om_i AFTER INSERT ON org_members
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_om_u AFTER UPDATE ON org_members
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_om_d AFTER DELETE ON org_members
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_dev_p AFTER UPDATE OF person_id ON devices
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_dev_r AFTER UPDATE OF revoked_at ON devices
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_io_i AFTER INSERT ON installation_owners
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_io_d AFTER DELETE ON installation_owners
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_ppl_r AFTER UPDATE OF revoked_at ON people
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_prev_org_r AFTER UPDATE OF revoked_at ON orgs
  BEGIN UPDATE principals_rev SET rev = rev + 1 WHERE singleton = 1; END;

-- ── 8. BOOTSTRAP. Nessuna UI, nessun login, nessuna rete: una migration è SQL.
--
-- Id CASUALI, mai deterministici. Un 'person-owner' letterale è identico su ogni
-- installazione al mondo, e collide il giorno che due DB si incontrano — secondo
-- Mac, restore di un backup, upload dell'anagrafe. Il codice non conosce questi
-- id: li trova da `installation_owners` e `installation`, che sono i puntatori.
--
-- Il nome è 'Proprietario', fisso e rinominabile. Non lo si indovina: inventare
-- un nome da uno user-agent è l'unica cosa che una persona non perdona.
INSERT INTO people (id, display_name, email, created_at, origin, rev, updated_at)
SELECT lower(hex(randomblob(16))), 'Proprietario', NULL,
       CAST(strftime('%s','now') AS INTEGER)*1000, 'local', 0,
       CAST(strftime('%s','now') AS INTEGER)*1000
WHERE NOT EXISTS (SELECT 1 FROM installation_owners);

INSERT INTO orgs (id, name, created_at, origin, rev, updated_at)
SELECT lower(hex(randomblob(16))), 'La mia organizzazione',
       CAST(strftime('%s','now') AS INTEGER)*1000, 'local', 0,
       CAST(strftime('%s','now') AS INTEGER)*1000
WHERE NOT EXISTS (SELECT 1 FROM installation);

INSERT INTO installation_owners (person_id, added_at, is_default)
SELECT id, created_at, 1 FROM people
WHERE NOT EXISTS (SELECT 1 FROM installation_owners)
ORDER BY created_at LIMIT 1;

INSERT INTO installation (singleton, org_id, created_at)
SELECT 1, id, created_at FROM orgs
WHERE NOT EXISTS (SELECT 1 FROM installation)
ORDER BY created_at LIMIT 1;

INSERT OR IGNORE INTO org_members (org_id, person_id, role, joined_at, rev, updated_at)
SELECT i.org_id, o.person_id, 'owner', i.created_at, 0, i.created_at
FROM installation i, installation_owners o WHERE o.is_default = 1;

-- I dispositivi 'owner' esistenti diventano della persona proprietaria. È
-- l'unica affermazione difendibile: per la 080/082 erano tutti «i miei
-- dispositivi» per definizione, e il cartello di pairing non ha MAI chiesto
-- niente (auth.ts:228 default-a 'owner'). Il caso in cui due umani vengono fusi
-- in una persona è reale ed è dichiarato fra i limiti accettati: la leva di
-- scorporo — «questo dispositivo è di un'altra persona» — fa parte della stessa
-- consegna, ed è una UPDATE di `devices.person_id` che non tocca nessuna grant,
-- perché le grant esistenti restano su soggetto 'device'.
UPDATE devices
   SET person_id = (SELECT person_id FROM installation_owners WHERE is_default = 1)
 WHERE role = 'owner' AND person_id IS NULL;

-- Ogni dispositivo 'guest' esistente diventa UNA persona, con il nome che aveva.
-- Non si fondono due telefoni sotto una persona inventata: sarebbe
-- un'affermazione falsa che poi nessuno sa smontare.
INSERT INTO people (id, display_name, email, created_at, origin, rev, updated_at)
SELECT lower(hex(randomblob(16))), d.name, NULL, d.created_at, 'local', 0,
       CAST(strftime('%s','now') AS INTEGER)*1000
FROM devices d WHERE d.role = 'guest' AND d.person_id IS NULL;
-- Riaggancio per nome+created_at: le righe appena inserite sono le uniche
-- persone con `created_at` uguale a quello del dispositivo e nessuna
-- appartenenza. (Il test della migration lo verifica riga per riga.)
UPDATE devices SET person_id = (
  SELECT p.id FROM people p
   WHERE p.display_name = devices.name AND p.created_at = devices.created_at
     AND NOT EXISTS (SELECT 1 FROM installation_owners io WHERE io.person_id = p.id)
   ORDER BY p.rowid DESC LIMIT 1
) WHERE role = 'guest' AND person_id IS NULL;

-- ── 9. GRANTS: ricostruita. SQLite non altera un CHECK in posto.
--
-- DUE allargamenti in un colpo solo, e il secondo è deliberato anche se la UI
-- non lo userà nella prima consegna:
--
--   subject_type: 'device' → 'device' | 'person' | 'org'.
--   level:        'read'   → 'read'   | 'deny'.
--
-- `deny` esiste ORA perché senza di esso non c'è modo di togliere UNA cosa a UNA
-- persona dentro un'organizzazione: le sole mosse sarebbero togliere all'org
-- (che la toglie a tutti) o togliere la persona dall'org (che le toglie tutto, e
-- che il prossimo pull ripristina). Aggiungerlo dopo vorrebbe dire ricreare
-- questa tabella una seconda volta. Costa sei caratteri nel CHECK e tre righe
-- nell'unica funzione che legge questa tabella; `deny` vince sempre su `read`.
--
-- `granted_by_person_id` è la firma che la 082 aveva promesso. È NULL per le
-- righe travasate: non sappiamo chi le ha fatte, e riempirla col proprietario
-- produrrebbe una colonna sempre popolata e vera talvolta — rumore che sembra un
-- dato. NULL è l'unica risposta onesta.
--
-- La UNIQUE resta sulla quaterna col tipo: la stessa risorsa può essere concessa
-- a una persona E alla sua organizzazione senza collidere, e sono due fatti
-- diversi con due revoche diverse.
CREATE TABLE grants_new (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('device','person','org')),
  subject_id    TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('task','topic')),
  resource_id   TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'read' CHECK (level IN ('read','deny')),
  via_type      TEXT,
  via_id        TEXT,
  granted_at    INTEGER NOT NULL,
  granted_by_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  UNIQUE (subject_type, subject_id, resource_type, resource_id)
);
-- Le righe esistenti NON vengono promosse da 'device' a 'person'. Promuoverle
-- cambierebbe il loro SIGNIFICATO — da «questo Mac» a «questa persona e tutti i
-- suoi dispositivi presenti e futuri» — cioè allargherebbe di sponda, dentro una
-- migration, un permesso che nessuno ha chiesto di allargare. Il prezzo
-- dichiarato è che due generazioni di righe convivono finché un umano non le
-- sostituisce.
INSERT INTO grants_new (id, subject_type, subject_id, resource_type, resource_id,
                        level, via_type, via_id, granted_at, granted_by_person_id)
SELECT id, subject_type, subject_id, resource_type, resource_id,
       level, via_type, via_id, granted_at, NULL
FROM grants;
DROP TABLE grants;                 -- nessuna FK punta a grants: niente cascate
ALTER TABLE grants_new RENAME TO grants;
-- La DROP si è portata via i tre indici della 083. Vanno ricreati, o la domanda
-- calda diventa una scansione e nessun test se ne accorge.
CREATE INDEX IF NOT EXISTS idx_grants_subject  ON grants(subject_type, subject_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_grants_resource ON grants(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_grants_via      ON grants(via_type, via_id);

-- ── COSA NON SI TOCCA QUI, ed è deliberato.
-- `devices.role` resta popolata e coerente per una release: nessun codice la
-- legge più (il confinamento si deriva), ma un rollback al binario precedente
-- deve trovare un DB che sa ancora rispondere. La droppa la 085, insieme a
-- `task_shares` (082), quando il grep conferma che nessuno le nomina — la
-- lezione è scritta nella 083 stessa.
--
-- UNION TS DA ALLINEARE, in `server/lib/grants.ts`, col validatore runtime che
-- oggi manca del tutto sul lato soggetto:
--   export type SubjectType = 'device' | 'person' | 'org';
--   export const SUBJECT_TYPES = ['device','person','org'] as const;
--   export function isSubjectType(v: unknown): v is SubjectType
--   export type GrantLevel = 'read' | 'deny';
--   export type Principal = { type: SubjectType; id: string };
-- Attenzione: `SubjectType` e `Grant` NON sono importati da nessun file
-- (verificato). Allargare l'union non produce un solo errore di compilazione: la
-- rete non è il compilatore, è `tests/unit/single-door.test.ts`.