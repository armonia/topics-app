-- 061: checks pre-review — un task non sta in review con i check rossi.
--
-- Il protocollo di consegna chiede evidenza verificabile ("una promessa non è
-- una consegna"), ma finora l'unica cosa che la rendeva vera era la buona
-- volontà dell'agente: i gate strutturali esistenti coprono il commit
-- (review_needs_commit) e il riassunto (review_needs_summary), non il fatto che
-- il codice compili. Questo è il terzo: i comandi li dichiara l'umano, li esegue
-- il SERVER nel worktree del task, e l'output finisce nel thread.
--
-- review_checks: JSON `[{"name":"typecheck","cmd":"bun run typecheck"}, …]`.
-- NULL o `[]` = gate spento, che è il default: nessuna board esistente cambia
-- comportamento finché qualcuno non dichiara cosa vuol far girare. Non si
-- inferisce niente da package.json apposta — `npm test` su questo repo è la
-- suite E2E, venti minuti, e un default che blocca ogni consegna per venti
-- minuti verrebbe spento il primo giorno.
ALTER TABLE board_settings ADD COLUMN review_checks TEXT;

-- Esito sul task. 'running' mentre girano, poi 'pass' | 'fail'.
-- NULL = mai girati (board senza check, task senza worktree, task vecchi).
ALTER TABLE tasks ADD COLUMN checks_state TEXT;
-- Quando è finita l'ultima esecuzione (ISO). Serve a dire "verdi, ma su un
-- commit di ieri": l'esito vale per il codice di quel momento.
ALTER TABLE tasks ADD COLUMN checks_at TEXT;
-- Il commit su cui sono girati: se il branch è avanzato, un 'pass' è scaduto.
ALTER TABLE tasks ADD COLUMN checks_commit TEXT;
-- JSON CheckRun[]: nome, comando, esito, durata e coda dell'output. È l'evidenza
-- che il reviewer legge senza doversi fidare del riassunto.
ALTER TABLE tasks ADD COLUMN checks_json TEXT;
