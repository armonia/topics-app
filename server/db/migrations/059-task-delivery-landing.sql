-- 059: legare "consegnato" a "è nel prodotto".
--
-- Il 19/07 il task b01711ff è passato in done, il suo branch è stato cancellato
-- e il lavoro non è mai arrivato su main. Nessuno se n'è accorto per 8 giorni
-- perché NESSUN controllo lega lo stato del task al contenuto di main.
--
-- Il branch di un task muore col reap, quindi non è un appiglio durevole: quello
-- che resta è il COMMIT consegnato. Lo registriamo al passaggio in `review` (il
-- momento della consegna) e l'audit periodico confronta quel commit con main —
-- per CONTENUTO, così regge anche lo squash-land.
--
--   delivery_branch     branch del task al momento della consegna (diagnostica)
--   delivery_commit     tip del branch a quel momento — l'appiglio durevole
--   landing_state       'landed' | 'unlanded' | 'unverifiable' | NULL (mai auditato)
--   landing_checked_at  ISO dell'ultimo controllo
ALTER TABLE tasks ADD COLUMN delivery_branch TEXT;
ALTER TABLE tasks ADD COLUMN delivery_commit TEXT;
ALTER TABLE tasks ADD COLUMN landing_state TEXT;
ALTER TABLE tasks ADD COLUMN landing_checked_at TEXT;
