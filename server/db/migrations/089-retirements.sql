-- Il ritiro, in un posto solo.
--
-- IL GUASTO. «Aperto» era scritto in tre registri che non si parlano:
--   1. `ui_state/pane-store-v2` — le pane piu' i loro tombstone. E' l'unico che
--      sa cosa l'interfaccia mostra davvero, ma vive dentro un blob JSON e
--      nessuna query lo interroga.
--   2. `terminal_sessions` — righe piu' PTY. Sa cosa gira, non sa se qualcuno
--      lo sta guardando.
--   3. `topics.archived` — un booleano senza data, quindi senza ordine.
-- Misurato il 03/08: 11 sessioni vive per tab chiuse a luglio, 2 topic
-- «aperti» che erano chiusi da settimane. Tre query, tre risposte diverse, e
-- nessuna delle tre d'accordo con lo schermo.
--
-- LA DECISIONE (Attilio, 03/08). Uno stato solo, ed e' la chiusura della tab:
-- chiudere una tab E' il ritiro di cio' che contiene. Niente terzo stato
-- «chiusa ma non archiviata».
--
-- QUESTA TABELLA E' QUEL FATTO. Una riga per cosa ritirata, con la DATA — che
-- e' la differenza che conta rispetto a `archived`: un booleano non si puo'
-- ordinare, quindi non si puo' dire quale delle due scritture e' arrivata
-- dopo, ne' riconciliare due dispositivi. I tre registri restano dove sono e
-- diventano VISTE su questo: chi vuole sapere cosa e' aperto guarda qui
-- (`services/retirement.ts#listOpen`), e le divergenze diventano una lista
-- invece di un sospetto.
--
-- PERCHE' UNA TABELLA E NON UNA COLONNA `retired_at` PER REGISTRO. Una colonna
-- per tabella sarebbe stata la quarta, quinta e sesta scrittura da tenere in
-- fila: lo stesso guasto con piu' posti. E soprattutto: il ritiro nasce sulla
-- PANE (la tab che l'utente chiude), che non e' una riga di nessuna tabella —
-- vive in un blob JSON. Solo un registro esterno puo' timbrare tutte e tre le
-- specie con lo stesso gesto.
--
-- `kind` e' vincolato: una specie sconosciuta e' un errore di scrittura, e va
-- rifiutata al bordo invece di diventare una riga che nessun lettore guarda
-- (vedi il precedente `INSERT OR IGNORE` che ingoiava i CHECK).
CREATE TABLE IF NOT EXISTS retirements (
  kind TEXT NOT NULL CHECK(kind IN ('pane', 'topic', 'terminal')),
  ref_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  -- Da dove viene il ritiro: 'tab-close', 'archive', 'attempt-reap',
  -- 'task-release', 'backfill:archived'. Serve al triage, non alla decisione.
  reason TEXT,
  PRIMARY KEY (kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_retirements_at ON retirements(retired_at);

-- BACKFILL. Ogni topic archiviato E' un topic ritirato: senza questo passo il
-- fatto nascerebbe vuoto e la prima riconciliazione leggerebbe «tutto aperto»,
-- riaprendo 170 chat archiviate. La data non la conosciamo — `updated_at` e' la
-- migliore approssimazione disponibile (l'archiviazione e' l'ultima scrittura
-- che quei topic hanno visto) e serve solo a ordinare, non a decidere.
INSERT OR IGNORE INTO retirements (kind, ref_id, retired_at, reason)
SELECT 'topic', id, updated_at, 'backfill:archived' FROM topics WHERE archived = 1;
