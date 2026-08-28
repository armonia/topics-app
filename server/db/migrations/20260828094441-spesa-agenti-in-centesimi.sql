-- 20260828094441-spesa-agenti-in-centesimi.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- LA SPESA DEGLI AGENTI, IN DOLLARI. Un agente dispacciato scriveva solo token
-- (`tasks.agent_tokens`, `agent_cache_read_tokens`): nessuna colonna in denaro,
-- da nessuna parte. La sonda del costo somma `messages.cost_cents`, che è il
-- libro della CHAT: sull'agente notturno era cieca. Misurato sul db vivo, la
-- board vale circa il 38% della spesa totale e non compariva in nessun
-- contatore in dollari.
--
-- DUE OGGETTI, perché rispondono a due domande diverse:
--
--   · `tasks.agent_cost_cents` è il CUMULATIVO di una card. È la colonna che si
--     mostra accanto ai token e quella su cui morde il tetto per card. Sale con
--     un pavimento MAX (vedi `raiseAgentUsage`): un turno non scritto lo
--     recupera il turno dopo, una lettura che regredisce non può sottrarre.
--
--   · `agent_spend` è il LIBRO con la data. Una finestra mobile di 24 ore non si
--     ricava da un cumulativo per card: la card più cara mai vista vale 99,70
--     USD, ma il giorno peggiore ne vale 2.569 spalmati su molte card ciascuna
--     sotto il proprio tetto. Senza righe timbrate, il tetto giornaliero non è
--     scrivibile: si scriverebbe «somma delle card toccate oggi», che conta
--     anche la spesa di ieri di quelle stesse card.
--
-- `unpriced_cost_tokens` è la quota di consumo che NON si è potuta prezzare (un
-- modello senza listino: vedi `unknownPricedModels` in server/usage/pricing.ts).
-- Sta accanto ai centesimi e non dentro: tariffare zero un modello sconosciuto
-- lo renderebbe indistinguibile da un turno gratis, e un tetto che ignora in
-- silenzio una fetta di spesa diventa decorativo. Si mostra accanto al numero.
ALTER TABLE tasks ADD COLUMN agent_cost_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS agent_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  cents INTEGER NOT NULL,
  unpriced_cost_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_spend_at ON agent_spend(at);
