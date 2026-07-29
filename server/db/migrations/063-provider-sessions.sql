-- La sessione che un provider tiene per conto suo, ricordata attraverso i riavvii.
--
-- Un agente ACP non è stateless: `session/new` gli fa nascere una conversazione
-- con la sua storia, e da lì in poi il filo è quell'id. Se l'id vive solo nella
-- memoria del server, ogni reload — un `kickstart`, un hot-reload in dev, un
-- crash — apre di nascosto una conversazione VUOTA sotto la stessa chat: la UI
-- mostra tutti i messaggi di prima, il modello non ne ricorda nessuno. È la
-- stessa classe di problema che `claude_code_sessions` risolve per la CLI di
-- Claude, e la soluzione è la stessa: scriverlo su disco.
--
-- Generica di proposito (chiave `provider` + `session_key`) invece di una
-- tabella per agente: il punto del 3.2 è che aggiungere un agente non aggiunge
-- codice, e una tabella per agente sarebbe codice.
--
-- `cwd` è la directory con cui la sessione è nata: ACP la fissa in `session/new`
-- e non la si può cambiare dopo. Se il workspace della topic cambia (bind a un
-- progetto, worktree nuova) la sessione vecchia sta guardando il posto
-- sbagliato, e va ricreata invece che ricaricata.
CREATE TABLE IF NOT EXISTS provider_sessions (
  provider            TEXT NOT NULL,
  session_key         TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  cwd                 TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (provider, session_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_sessions_key
  ON provider_sessions(session_key);
