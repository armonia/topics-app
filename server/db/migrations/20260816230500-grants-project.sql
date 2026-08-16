-- UN PROGETTO SI PUÒ CONDIVIDERE.
--
-- Fino a qui `resource_type` ammetteva `task` e `topic`, e basta. Un progetto
-- non era una risorsa condivisibile: niente da mostrare col tasto destro su di
-- lui, nessuna icona di organizzazione sulla sua tab, e le colonne
-- `via_type`/`via_id` della 083 — nate proprio per «condividi un progetto, e i
-- suoi task nascono con via=('project', X)» — restavano inerti, perché quel
-- contenitore non esisteva.
--
-- LA STRADA È L'ESPANSIONE IN LETTURA, non le righe derivate.
--
-- Le due erano un bivio dichiarato. Righe derivate: condividere un progetto
-- scrive una riga per ogni task, ed è ciò che lo schema 083 aveva previsto.
-- Costo: vanno mantenute quando un task nasce, si sposta di progetto o viene
-- archiviato, e ogni disallineamento è una condivisione fantasma — cioè un
-- accesso che nessuno ha concesso e nessuno vede.
--
-- Espansione in lettura: la condivisione resta UNA riga sul progetto, e la
-- domanda «questo task si può leggere?» guarda anche il progetto che lo
-- contiene. È la stessa forma che la 084 ha scelto per l'altro asse (un
-- dispositivo porta con sé la sua persona e le sue organizzazioni), quindi non
-- introduce un secondo modello nella stessa tabella. Un task cambia progetto?
-- L'accesso segue, senza che nessuno debba ricordarselo.
--
-- NON ENTRAMBE: due meccanismi per la stessa domanda sono due risposte che
-- prima o poi divergono, e la seconda si scopre quando qualcuno vede una cosa
-- che non doveva.
--
-- `via_type`/`via_id` RESTANO INERTI, e adesso per una ragione diversa: con
-- l'espansione in lettura non esiste nessuna riga derivata da etichettare. La
-- provenienza si calcola quando serve dirla (`reasonsFor`), non si memorizza.
--
-- SQLite non sa modificare un CHECK: la tabella si ricrea e si ricopia. Le
-- righe esistenti passano tutte — il vincolo si ALLARGA, non si stringe.
PRAGMA foreign_keys = OFF;

CREATE TABLE grants_nuova (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('device', 'person', 'org')),
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('task', 'topic', 'project')),
  resource_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('read', 'deny')),
  granted_at INTEGER NOT NULL,
  granted_by TEXT,
  via_type TEXT,
  via_id TEXT,
  UNIQUE (subject_type, subject_id, resource_type, resource_id)
);

INSERT INTO grants_nuova
  SELECT id, subject_type, subject_id, resource_type, resource_id,
         level, granted_at, granted_by, via_type, via_id
    FROM grants;

DROP TABLE grants;
ALTER TABLE grants_nuova RENAME TO grants;

CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject_type, subject_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_grants_resource ON grants(resource_type, resource_id);

PRAGMA foreign_keys = ON;
