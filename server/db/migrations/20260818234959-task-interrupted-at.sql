-- 20260818234959-task-interrupted-at.sql
--
-- Il prefisso e' un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: e' quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- UN TURNO TAGLIATO DA UN RIAVVIO E' UN FATTO SCRITTO, NON UNA DEDUZIONE.
-- Fino a qui lo spegnimento non toccava una riga di `tasks`: per tutta la
-- finestra morta la board diceva «sta lavorando» sopra un processo che non
-- esisteva, e lo stato «interrotto» veniva INDOVINATO dal boot successivo
-- guardando il chip rimasto li'.
--
--   interrupted_at          quando il turno e' stato tagliato (ISO 8601)
--   interrupted_by          da cosa: il segnale dello shutdown (SIGTERM, ...)
--   interrupted_notified_at quando lo si e' DETTO nel thread della card
--
-- La terza colonna e' il dedupe permanente della nota per le card che il
-- recupero non riprendera' mai (chip non recuperabile): senza, un reconcile
-- ogni 10 secondi riscriverebbe la stessa frase per sempre. Si riarma da sola
-- quando arriva una interruzione NUOVA, cioe' quando interrupted_at avanza.
ALTER TABLE tasks ADD COLUMN interrupted_at TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN interrupted_by TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN interrupted_notified_at TEXT DEFAULT NULL;
