-- Il goal si persegue da solo: lo stato del ciclo di continuazione, sul goal.
--
-- Prima di questa migration un goal `active` era una riga di stato e basta:
-- l'envelope la re-iniettava a ogni turno, ma quando il turno finiva non
-- succedeva niente. Adesso il server, a fine turno, chiede a un giudice
-- economico se l'obiettivo regge e nel caso rimanda un messaggio di
-- continuazione (server/services/goal-loop.ts).
--
-- Perche' le tre colonne stanno QUI e non in memoria: i freni di un ciclo
-- automatico devono sopravvivere a un riavvio. Un contatore in RAM si azzera
-- col processo, e un tetto che si azzera non e' un tetto, e' un ciclo che
-- ricomincia da capo ogni volta che il server riparte (lo stesso difetto
-- misurato sulla ripresa dei turni, dove il conteggio stava sulla riga
-- sbagliata e il tetto non veniva raggiunto mai).
--
-- Le colonne muoiono col goal: chiudere l'obiettivo o dichiararne un altro
-- ferma il ciclo per costruzione, perche' il ciclo si legge solo dal goal
-- `active`.

-- Quante continuazioni consecutive ha gia' speso QUESTO goal. Il tetto vive nel
-- codice (`MAX_GOAL_CONTINUATIONS`), il conteggio qui.
ALTER TABLE topic_goals ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0;

-- Turni di fila senza lavoro (nessun tool eseguito). Due di fila e il ciclo si
-- ferma: un modello che risponde «continuo» senza toccare niente non sta
-- avanzando, sta comprando turni.
ALTER TABLE topic_goals ADD COLUMN idle_turns INTEGER NOT NULL DEFAULT 0;

-- Lo stato del ciclo, che e' cosa diversa dallo stato del goal:
--   'running' = a fine turno si valuta e, se serve, si continua;
--   'blocked' = il giudice ha visto una domanda all'utente: si aspetta lui;
--   'stopped' = fermato (tetto, nessun progresso, o il bottone Ferma).
-- Un goal puo' essere `active` con il ciclo `stopped`: l'obiettivo resta nel
-- contesto, semplicemente nessuno lo insegue piu' da solo.
ALTER TABLE topic_goals ADD COLUMN loop_state TEXT NOT NULL DEFAULT 'running';
