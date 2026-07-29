-- 064: goal della chat — l'equivalente del task di board, dentro una conversazione.
--
-- Sulla board un task È un goal: ha un testo, uno stato, e resta lì finché
-- qualcuno lo chiude. In chat non c'era l'equivalente. Una conversazione lunga
-- è un flusso: l'obiettivo lo si scrive nel primo messaggio, scorre via, e dopo
-- una compattazione il modello non ce l'ha più — è esattamente quando ricomincia
-- a fare la cosa sbagliata con grande sicurezza.
--
-- Il goal vive FUORI dal transcript apposta. Se fosse un messaggio sarebbe
-- soggetto a compaction, a edit, a branch, e finirebbe per esistere in tre
-- versioni. Qui è una riga di stato: l'envelope la inietta come system block a
-- ogni turno (anche in leanContext, che è il turno di ripresa del dispatcher),
-- quindi sopravvive a qualunque compattazione.
--
-- Storico, non riga singola: chiudere un goal e aprirne un altro è il modo
-- normale di lavorare in una topic lunga, e "cosa stavamo cercando di fare
-- martedì" è una domanda legittima. L'invariante è che UN SOLO goal per topic
-- stia in 'active' — la garantisce l'indice parziale qui sotto, non il codice.
CREATE TABLE IF NOT EXISTS topic_goals (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL,
  content     TEXT NOT NULL,
  -- 'active' = lo stiamo perseguendo (iniettato nel contesto).
  -- 'achieved' = raggiunto. 'abandoned' = lasciato perdere.
  -- Entrambi gli stati finali escono dal contesto e restano nello storico.
  status      TEXT NOT NULL DEFAULT 'active',
  -- 'human' | 'agent': chi l'ha scritto. Un goal proposto dall'agente (dal
  -- `plan` di ACP) non ha lo stesso peso di uno dettato dall'umano, e la UI
  -- deve poterlo dire senza indovinare.
  created_by  TEXT NOT NULL DEFAULT 'human',
  created_at  TEXT NOT NULL,
  -- Quando è passato a uno stato finale. NULL finché è active.
  closed_at   TEXT,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);

-- L'invariante "un solo goal attivo per topic", imposta dal DB. Il servizio
-- chiude il precedente prima di aprirne uno nuovo; se un giorno sbaglia, qui
-- prende un vincolo violato invece di lasciare due goal a litigare nel prompt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_goals_one_active
  ON topic_goals (topic_id) WHERE status = 'active';

-- Lo storico si legge per topic, in ordine di creazione.
CREATE INDEX IF NOT EXISTS idx_topic_goals_topic ON topic_goals (topic_id, created_at DESC);

-- I passi del goal: la lista di cose da fare che l'agente dichiara.
--
-- Da dove arrivano: dal `plan` di ACP (`session/update` con
-- `entries: [{content, priority, status}]`), che finora
-- `translateSessionUpdate` scartava con un ramo esplicito e un test che lo
-- bloccava — l'aggancio era stato lasciato lì apposta per questa migration.
--
-- Perché una tabella e non JSON nel goal: i passi si aggiornano UNO alla volta
-- (un `plan` update riscrive l'elenco a ogni cambio di stato) e vanno letti in
-- ordine. Una colonna JSON riscritta per intero a ogni tick è una corsa che
-- prima o poi si perde; qui la riscrittura è una transazione sola.
CREATE TABLE IF NOT EXISTS topic_goal_steps (
  id         TEXT PRIMARY KEY,
  goal_id    TEXT NOT NULL,
  -- Posizione nell'elenco, 0-based. L'agente può riordinare: è l'ordine che
  -- conta, non l'id.
  position   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  -- Lo stesso vocabolario di ACP e di TodoWrite, così le due sorgenti si
  -- fondono senza tradurre due volte.
  status     TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES topic_goals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_goal_steps_goal ON topic_goal_steps (goal_id, position);
