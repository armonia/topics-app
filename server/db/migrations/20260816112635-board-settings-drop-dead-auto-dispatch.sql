-- `board_settings.auto_dispatch` sulle righe PER-PROGETTO e' dato morto, e mente.
--
-- COSA SUCCEDEVA. Dalla 038 l'auto-dispatch e' un interruttore GLOBALE: lo porta
-- la riga riservata `project_id = '*'`, e lettura e scrittura ci puntano
-- entrambe. La colonna esiste pero' su OGNI riga, con `DEFAULT 0`, e nessuno la
-- scrive mai per un progetto vero: l'`INSERT OR IGNORE` che crea la riga di una
-- board non la nomina nemmeno. Il risultato e' che ogni board nasce con uno zero
-- che non significa niente.
--
-- Quello zero ha gia' prodotto due diagnosi sbagliate, l'11/08 e il 15/08, dalla
-- stessa colonna: «sei board risultano spente nel DB e girano lo stesso, c'e' un
-- bug». Non c'era nessun bug — c'era un default letto come una scelta. La prova
-- che la colonna e' scollegata dalla realta' e' che due board che avevano
-- dispacciato nelle 24h precedenti non avevano proprio una riga in
-- `board_settings`.
--
-- PERCHE' TOGLIERLA invece di darle un senso. Le strade erano due: farne il vero
-- override per board, o eliminarla. La seconda, per una ragione che la prima non
-- risolve: un dato che non ha lettori ma HA un valore plausibile e' peggio di un
-- dato assente, perche' chi apre il DB lo legge e ci crede. Un override per board
-- resta una cosa sensata da avere, ma va progettato (l'UI oggi dice «vale per
-- tutte le board» ovunque, e due interruttori con la stessa etichetta sono un
-- guasto nuovo); e va fatto su una colonna che nasce con quel significato, non
-- riciclando quella che per mesi ne ha avuto un altro.
--
-- L'INTERRUTTORE GLOBALE SI SPOSTA, non sparisce: va in `app_settings`, che e'
-- dove vivono gia' tutte le preferenze di macchina (`agent_runtime`,
-- `ai_provider`...). E' anche il posto che dice la verita' sul suo conto: una
-- riga sola per una impostazione sola, invece di una riga riservata dentro una
-- tabella per progetto — che era esattamente cio' che rendeva credibile lo zero
-- delle altre righe.
--
-- IL VALORE VIVO SI PORTA DIETRO, e questo e' il punto delicato: se qui si
-- perdesse lo stato, ogni installazione con l'auto-dispatch ACCESO si
-- risveglierebbe spenta, e la coda si fermerebbe in silenzio finche' qualcuno
-- non se ne accorge. Si copia dalla riga '*' prima di lasciarla andare.
--
-- SQLite regge `DROP COLUMN` dalla 3.35, e bun:sqlite ne porta una piu' recente;
-- gli indici su questa colonna non ce ne sono (l'unica chiave e' `project_id`).

-- 1. L'interruttore globale trova casa fra le impostazioni di macchina.
ALTER TABLE app_settings ADD COLUMN auto_dispatch INTEGER;

-- 2. Ci si porta il valore che era vivo sulla riga riservata. `app_settings` ha
--    una riga sola (id = 1 per costruzione); se per qualche motivo non ci fosse,
--    l'UPDATE non tocca niente e il codice ricade sul suo default, che e' spento
--    — il verso giusto in cui sbagliare, perche' l'errore opposto sarebbe
--    dispacciare agenti veri su una macchina dove nessuno lo aveva chiesto.
UPDATE app_settings
   SET auto_dispatch = COALESCE(
     (SELECT auto_dispatch FROM board_settings WHERE project_id = '*'),
     0
   );

-- 3. Via lo zero che mentiva su ogni riga per progetto.
ALTER TABLE board_settings DROP COLUMN auto_dispatch;
