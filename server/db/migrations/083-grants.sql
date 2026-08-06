-- 083: un modello solo — soggetto → concessione → risorsa.
--
-- La 082 aveva fatto la cosa minima che serviva: `task_shares(task_id,
-- device_id)`. Funziona, ma è una tabella per UN tipo di risorsa e UN tipo di
-- soggetto. Aggiungere le chat vorrebbe dire `topic_shares`; aggiungere le
-- persone vorrebbe dire raddoppiare entrambe. Cinque tabelle che divergono sono
-- il modo in cui «condivisione ovunque» diventa cinque comportamenti diversi.
--
-- Quindi UNA tabella, e le due colonne che la rendono generale:
--
--   SOGGETTO — chi riceve. Oggi solo `device`, perché è l'unica identità che
--     esiste. Domani `person` e `org`: si aggiunge un valore all'enum e una
--     tabella di risoluzione (device→persona→organizzazione), NON un secondo
--     sistema di accessi. L'accesso resta ancorato al dispositivo (il cookie);
--     il permesso si sposta sul principale.
--
--   RISORSA — cosa si riceve. Oggi `task` e `topic`, le due entità che hanno una
--     riga vera a cui appendere un permesso. Spazi e tab NON sono qui e non
--     possono esserci: vivono dentro un blob JSON da 56 KB in una riga sola di
--     `ui_state`, che si scrive tutto intero con un CAS. Non c'è un «questo» da
--     indicare, e una riga di permesso verso un id che non esiste sarebbe una
--     promessa che il server non può mantenere.
--
-- `via_type`/`via_id` — LA PROVENIENZA, ed è ciò che rende rispondibile la
-- domanda «perché costui vede questa cosa?». NULL = concessa a mano. Valorizzata
-- = derivata da un contenitore (condividi un progetto, e i suoi task nascono con
-- `via=('project', X)`). Serve a togliere in blocco ciò che un contenitore aveva
-- dato, senza toccare le concessioni esplicite — che è la differenza fra
-- revocare un accesso e cancellare il lavoro di qualcuno.
--
-- NESSUNA gerarchia implicita nella lettura. Il permesso si MATERIALIZZA in
-- righe quando lo si concede, e la verifica resta una SELECT su una riga. Un
-- modello che risolve l'ereditarietà a ogni richiesta girando un grafo è quello
-- in cui «chi vede questa cosa?» smette di avere una risposta esatta — ed è il
-- guasto ricorrente di ogni prodotto che ha provato a essere generoso qui.
CREATE TABLE IF NOT EXISTS grants (
  id            TEXT PRIMARY KEY,
  -- 'device' oggi. Il CHECK va tenuto allineato all'union TypeScript: in questo
  -- repo i due sono già andati in deriva due volte (migration 029 e 066), e il
  -- sintomo è sempre lo stesso — una riga che il client sa scrivere e il DB
  -- rifiuta, o viceversa.
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('device')),
  subject_id    TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('task', 'topic')),
  resource_id   TEXT NOT NULL,
  -- Solo 'read' oggi. 'comment' e 'write' esistono nel vocabolario ma NON sono
  -- ammessi: un ospite che scrive in un thread o in un terminale è una superficie
  -- completamente diversa, e va progettata quando il caso esisterà davvero.
  level         TEXT NOT NULL DEFAULT 'read' CHECK (level IN ('read')),
  via_type      TEXT,
  via_id        TEXT,
  granted_at    INTEGER NOT NULL,
  UNIQUE (subject_type, subject_id, resource_type, resource_id)
);

-- La domanda calda, una per richiesta: «cosa vede QUESTO soggetto».
CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject_type, subject_id, resource_type);
-- La domanda dell'interfaccia: «chi vede QUESTA cosa».
CREATE INDEX IF NOT EXISTS idx_grants_resource ON grants(resource_type, resource_id);
-- Per togliere in blocco ciò che un contenitore aveva dato.
CREATE INDEX IF NOT EXISTS idx_grants_via ON grants(via_type, via_id);

-- Le righe già esistenti si portano dentro. `task_shares` non si cancella qui:
-- una migration che droppa una tabella nello stesso giro in cui ne popola
-- un'altra non lascia niente da guardare se il travaso è andato storto. La si
-- toglie quando il codice non la nomina più.
INSERT OR IGNORE INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at)
SELECT
  'g-' || task_id || '-' || device_id,
  'device', device_id, 'task', task_id, 'read', shared_at
FROM task_shares;
