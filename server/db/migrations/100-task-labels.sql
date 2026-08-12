-- 100: le etichette dei task. Molti-a-molti, non una stringa con virgole.
--
-- IL NUMERO è 100 e non 097: mentre questo ramo era in volo, main si è preso
-- 097 (`task-plan-comment`), 098 e 099. Il registro delle migration conta i
-- NUMERI, non i nomi: due file con lo stesso numero e il runner applica il primo
-- e SALTA il secondo — senza dirlo. La tabella qui sotto non sarebbe mai nata, e
-- il difetto sarebbe uscito a runtime con un `no such table` che non nomina la
-- causa. È già successo con la 089 (vedi `scripts/check-migration-numbers.ts`,
-- che è il cancello che lo becca prima del land).
--
-- PERCHÉ ORA. L'11/08/2026 la coda di review di topics contava una trentina di
-- card. Rifatto il conto con le TRE classi che questa tabella etichetta: 21
-- toccavano `client/src` (Attilio le può guardare), 7 erano piani, ricerche e
-- documenti (le più umane di tutte: le decide lui), e solo 2 erano codice che
-- nessuno vede — server, script, test. Stavano tutte nello stesso mucchio solo
-- perché mancava la regola che dicesse chi le chiude. Questa tabella è dove
-- quella regola si scrive una volta.
--
-- PERCHÉ NON UNA COLONNA `labels TEXT`. Perché il caso d'uso è FILTRARE, e su
-- una stringa il filtro diventa `LIKE '%bugfix%'` — che matcha `bugfix-ui`, e in
-- generale risponde a una domanda diversa da quella fatta. Con una riga per
-- etichetta il filtro è un JOIN e un indice, e un'etichetta nuova non è una
-- migration dei dati.
--
-- PERCHÉ `source`. Le tre scritture non hanno lo stesso peso, e senza saperlo
-- non si può decidere chi vince:
--   · `derived` — la calcola la macchina dal diff a ogni consegna. Riscrivibile.
--   · `human`   — l'ha corretta Attilio. La derivazione non la tocca più, o la
--                 correzione a mano scadrebbe alla consegna successiva.
--   · `agent`   — l'ha chiesta l'agente. Solo per ciò che un agente può
--                 scrivere: `visibile` (alzare la mano) e le etichette di
--                 genere. MAI `invisibile` — quello sarebbe il permesso di
--                 chiudersi le card da solo, e il cancello sta in
--                 `server/routes/tasks.ts` con il suo test rosso.
--
-- Il vocabolario NON è vincolato qui da un CHECK: sta in `shared/task-labels.ts`
-- (`TASK_LABELS`), lo applica il layer route su ogni scrittura, ed è quello che
-- leggono anche il client e la derivazione. Un CHECK in SQL sarebbe una seconda
-- lista libera di divergere dalla prima — la stessa deriva documentata in
-- `server/db/migrations/029-terminal-session-type-check.sql`: aggiungere un
-- valore all'union TS senza toccare il vincolo fa fallire l'INSERT a runtime.
--
-- NOTA STORICA: `tags` + `task_tags` esistevano dalla 001 e sono state
-- ELIMINATE dalla 067 — 0 righe, 0 letture, nessuna UI. Non si resuscitano:
-- quelle erano etichette libere con un colore, cioè una tassonomia; queste sono
-- un insieme chiuso in cui `invisibile` decide chi chiude la card.

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('derived', 'human', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, label)
);

-- Il filtro della board è «dammi le card con questa etichetta», per progetto e
-- per colonna: si parte dall'etichetta e si risale ai task.
CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label);
