-- 092: a chi APPARTIENE un progetto, e quale progetto non si racconta a nessuno.
--
-- `projects` nasce nella 016 senza proprietario: un id, un nome, un path. Andava
-- bene finché l'unico soggetto era la macchina. Dalla 084 i soggetti sono tre —
-- dispositivo, persona, organizzazione — e la domanda «chi vede questo
-- progetto?» non ha una risposta scritta da nessuna parte: la rotta
-- `/api/projects` li consegna TUTTI a chiunque non sia un ospite.
--
-- Qui si scrivono le due colonne che servono a rispondere, e nient'altro.
--
-- `org_id` — L'ORGANIZZAZIONE CHE LO VEDE. È il verso in cui la richiesta
-- arriva: «due persone nella stessa org vedono gli stessi progetti». Nessuna
-- tabella ponte `project_members`: un progetto sta in UNA organizzazione, come
-- una persona sta in N organizzazioni ma nessuna org sta dentro un'altra (la
-- profondità fissa della 084 è la condizione di validità di tutto il disegno, e
-- una tabella ponte qui la romperebbe di sponda).
--
-- `owner_person_id` — CHI L'HA MESSO LÌ. Serve al solo caso `incognito`: senza,
-- «nascosto ai compagni d'org» significherebbe «nascosto anche a me», cioè un
-- progetto che scompare a chi l'ha marcato. Non è un permesso: non allarga
-- niente a nessuno.
--
-- `incognito` — LA LEVA, ed è l'unica cosa che un umano tocca. 0/1, default 0:
-- un progetto è dell'organizzazione a meno che qualcuno non dica di no.
-- L'inverso — incognito di default, condiviso su richiesta — è il default
-- prudente sbagliato: renderebbe la funzione invisibile e la lascerebbe spenta
-- per sempre.
--
-- IL RIEMPIMENTO E COSA ALLARGA DAVVERO. Le righe esistenti prendono l'org
-- dell'installazione e la persona proprietaria di default. Va detto senza giri:
-- se quell'org ha già più membri, questa riga rende i progetti già esistenti
-- visibili a loro — che è esattamente la modifica chiesta, non un effetto
-- collaterale. Se `installation` è vuota (nessuna org: l'installazione di chi
-- non ha mai sentito parlare di organizzazioni) `org_id` resta NULL, e NULL
-- significa la cosa più stretta possibile: lo vede solo chi possiede questa
-- macchina, cioè il comportamento byte per byte di prima della migration.
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE projects ADD COLUMN owner_person_id TEXT REFERENCES people(id);
ALTER TABLE projects ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0 CHECK (incognito IN (0, 1));

-- La domanda calda è «i progetti della mia org, esclusi gli incognito», e
-- l'indice la copre nell'ordine in cui viene fatta. Parziale perché le righe con
-- `org_id` NULL non passano mai da questa strada: le decide il proprietario.
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id, incognito)
  WHERE org_id IS NOT NULL;

UPDATE projects
   SET org_id          = (SELECT org_id FROM installation WHERE singleton = 1),
       owner_person_id = (SELECT person_id FROM installation_owners WHERE is_default = 1)
 WHERE org_id IS NULL;
