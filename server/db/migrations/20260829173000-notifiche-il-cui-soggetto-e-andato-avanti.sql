-- LA CAMPANELLA CONTAVA 400, IL RESTO DELLA APP CONTAVA 10.
--
-- Non erano due letture dello stesso insieme: erano due insiemi. Il glifo del
-- chrome (tray e icona: un solo `count`, una sola chiamata, non possono
-- divergere fra loro) conta LAVORO PENDENTE, cioe' stato vivo. La campanella
-- conta EVENTI in un registro a 30 giorni. Unita' diverse per costruzione, e
-- va bene: quello che non va bene e' che gli eventi non si spengono mai.
--
-- Misurato su `data/topics.db` il 29/08/2026, 400 righe non viste:
--     session      325   target_kind NULL, group_key NULL
--     task-review   74   group_key = 'task:<id>', target_kind = 'task'
--     task-parked    1   idem
--
-- I DUE CASI SONO DIVERSI, e questa migration spegne solo cio' che e' gia'
-- passato. Non tocca niente che sia ancora da guardare.
--
-- 1. task-review / task-parked cui il TASK e' andato avanti. Queste righe la
--    chiave ce l'hanno: `markTargetNotificationsSeen('task', id)` le
--    spegnerebbe. Nessuno la chiama - in tutto il repo quella funzione ha UN
--    solo chiamante, `topics.ts:1745`, e solo per i topic. Quindi una card
--    approvata tre settimane fa tiene ancora acceso il suo avviso.
--
-- 2. le righe `session`. Nascono senza `target_kind` e senza `group_key`
--    (`useCompletionNotifier` passa un `dedupeKey` 'terminal:<sid>' ma nessuna
--    chiave di gruppo), quindi NESSUN gesto puo' spegnerle una per una: l'unica
--    porta e' aprire il pannello della campanella, che le spegne tutte.
--    Segnalano un comando finito - un fatto transitorio - e restano accese per
--    trenta giorni. Le righe piu' vecchie di un'ora sono cronaca.
--
-- Il rimedio per il FUTURO sta nel codice (group key alla nascita); questa
-- migration e' per le righe che qualcuno sta guardando adesso, che il codice
-- nuovo non tocca. Un fix che riguarda solo il futuro, su dati che sono a
-- schermo, e' mezzo fix.

-- 1. L'avviso di una card che non e' piu' in quello stato.
UPDATE notification_log
   SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE seen_at IS NULL
   AND kind = 'task-review'
   AND target_kind = 'task'
   AND target_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM tasks t
          WHERE t.id = notification_log.target_id
            AND t.status = 'review'
       );

UPDATE notification_log
   SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE seen_at IS NULL
   AND kind = 'task-parked'
   AND target_kind = 'task'
   AND target_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM tasks t
          WHERE t.id = notification_log.target_id
            AND t.dispatch_state = 'needs_input'
       );

-- 2. Il comando finito piu' di un'ora fa. La finestra c'e' apposta: un
--    terminale che ha appena finito e' ancora una notizia, e questa migration
--    non deve rubare un avviso arrivato mentre l'aggiornamento girava.
UPDATE notification_log
   SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE seen_at IS NULL
   AND kind = 'session'
   AND group_key IS NULL
   AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour');
