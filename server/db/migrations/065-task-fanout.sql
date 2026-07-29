-- 065: fan-out — lo STESSO task a N agenti, in N worktree paralleli.
--
-- Fin qui il modello è stato uno-a-uno: un task, un topic, un worktree, un
-- branch. Tutta la catena a valle (diff, checks pre-review, land, preview,
-- reap) risolve attraverso UNA sola indirezione — `tasks.assigned_topic_id`
-- → `topics.worktree_id` (`worktreeOfTask` in server.ts). Il fan-out non la
-- rompe: aggiunge i TENTATIVI accanto, e scegliere il vincitore vuol dire
-- ri-puntare `assigned_topic_id` sul suo topic. Da quel momento ogni pezzo a
-- valle guarda il worktree giusto senza sapere che esiste un fan-out.
--
-- Perché una tabella e non N subtask: un sottotask è la CHECKLIST di un task
-- (protocollo di consegna: un task con sottotask aperti non è approvabile), e
-- i tentativi non sono passi da completare tutti — sono alternative di cui una
-- sola sopravvive. Modellarli come subtask renderebbe il task non approvabile
-- per costruzione e mostrerebbe sulla board tre card per un lavoro solo.
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- 1..N: l'ordine di lancio, quello che l'umano legge come "tentativo 2".
  idx INTEGER NOT NULL,
  -- La chat dell'agente di QUESTO tentativo: è il deep-link "apri la sessione"
  -- e, per il vincitore, il valore che finisce in tasks.assigned_topic_id.
  topic_id TEXT,
  -- Il worktree isolato. Per i perdenti è ciò che va reapato alla scelta.
  worktree_id TEXT,
  branch TEXT,
  model TEXT,
  -- running   → il turno è vivo
  -- delivered → il turno è finito e il tentativo ha prodotto qualcosa
  -- failed    → il turno è finito male (o non ha prodotto nulla)
  -- selected  → scelto dall'umano: è la consegna del task
  -- discarded → scartato alla scelta di un altro; worktree e branch reapati
  state TEXT NOT NULL DEFAULT 'running',
  -- Fotografia al termine del turno, NON ricalcolata a ogni lettura: è
  -- l'equivalente per-tentativo di delivery_commit — ciò che questo agente
  -- aveva prodotto quando ha finito, non ciò che il disco dice adesso.
  commit_sha TEXT,
  files_changed INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  -- L'ultima prosa dell'agente: il "cosa ho fatto" con cui si confrontano i
  -- tentativi. Senza, il confronto sarebbe tre numeri e nessun perché.
  summary TEXT,
  error TEXT,
  agent_ms INTEGER NOT NULL DEFAULT 0,
  agent_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  selected_at TEXT,
  UNIQUE (task_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);

-- Quanti agenti in parallelo per task su questa board. NULL/1 = comportamento
-- di sempre (un agente, il path a uno-a-uno, byte per byte lo stesso codice):
-- nessuna board esistente cambia comportamento finché qualcuno non alza il
-- numero. Il tetto vero resta quello globale di concorrenza — un fan-out da 3
-- occupa 3 slot come 3 task distinti, perché è esattamente quello che è.
ALTER TABLE board_settings ADD COLUMN dispatch_fanout INTEGER;
