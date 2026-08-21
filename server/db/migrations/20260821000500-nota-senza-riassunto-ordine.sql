-- La nota «senza riassunto» diventa anche l'ULTIMA parola, non solo visibile.
--
-- PERCHÉ UNA SECONDA MIGRATION per la stessa cosa. La `20260820235900` fa già
-- due UPDATE: promuove il kind e sposta il timestamp. Ma è stata applicata su
-- questo database mentre il file conteneva ancora la sola prima UPDATE — un
-- test l'ha eseguita alle 21:58:39, io ho aggiunto la seconda parte dopo.
-- `schema_migrations` la dà per applicata, quindi non girerà mai più, e la
-- parte mancante resterebbe non applicata per sempre: le note promosse
-- resterebbero SOTTO la chiusura del fan-out, e la card continuerebbe a
-- mostrare «Fan-out chiuso: 3 tentativi».
--
-- Modificare la migration già applicata non serve a niente (non rigira) e
-- riscriverne la riga in `schema_migrations` sarebbe peggio: farebbe rigirare
-- anche la prima UPDATE su chi l'ha già presa intera. Una migration nuova e
-- IDEMPOTENTE è l'unica strada che vale per entrambi i casi — chi ha preso la
-- versione parziale la completa, chi ha preso quella intera non cambia di un
-- millisecondo, perché il `WHERE` non trova più niente da fare.
--
-- La lezione, e vale oltre questo file: una migration è applicata UNA volta e
-- basta. Modificarla dopo che è girata da qualche parte non la fa girare di
-- nuovo — su quel database la modifica semplicemente non esiste.
UPDATE task_comments
   SET created_at = strftime('%Y-%m-%dT%H:%M:%f', created_at, '+1 second') || 'Z'
 WHERE kind = 'comment'
   AND author = 'system'
   AND content = 'Consegna senza riassunto: il turno e'' finito prima che l''agente commentasse.'
   AND EXISTS (
     SELECT 1 FROM task_comments f
      WHERE f.task_id = task_comments.task_id
        AND f.content LIKE 'Fan-out chiuso%'
        -- Sul SECONDO, non sull'istante: le due righe nascono nello stesso
        -- giro ma con millisecondi diversi (…15.403Z e …15.422Z), quindi un
        -- `=` secco non combacia mai.
        AND substr(f.created_at, 1, 19) = substr(task_comments.created_at, 1, 19)
        AND f.rowid > task_comments.rowid
   );
