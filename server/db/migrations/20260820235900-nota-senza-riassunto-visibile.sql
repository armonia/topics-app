-- Le note «senza riassunto» già scritte diventano visibili sulla card.
--
-- IL CODICE NUOVO NON BASTA, ed è il difetto che questa migration ripara.
-- `deliverToReviewBySystem` ora scrive quella nota come `kind: 'comment'`,
-- così la card la mostra invece di scartarla (`isThreadSpeech` butta via
-- 'status' e 'service'). Ma vale per le consegne FUTURE: le righe già in
-- database restano 'service', quindi le card che le portano continuano a
-- mostrare la contabilità del fan-out — «Fan-out chiuso: 3 tentativi» — e chi
-- rivede continua a non sapere perché manchi un riassunto.
--
-- Verificato a schermo il 20/08 su `235afe11`: cambiato il codice, ricostruito
-- il bundle e ricaricata l'app, la card mostrava ancora la stessa riga di
-- prima. Un fix che riguarda solo il futuro, su dati che l'utente sta
-- guardando ADESSO, è mezzo fix.
--
-- Misura al momento della scrittura: 24 righe su 24 card distinte, di cui 2 su
-- card ancora in review.
--
-- PERCHÉ È SICURO. Si tocca una sola colonna di righe riconosciute da tre
-- condizioni insieme (autore, kind, testo esatto), e il testo è una costante
-- del codice, non qualcosa che una persona possa aver scritto per caso:
-- nessun commento umano può finire in questo insieme. L'effetto è additivo —
-- una riga che era invisibile diventa visibile — e non cancella niente.
--
-- PERCHÉ NON TOCCA L'ALTRA OCCORRENZA. La stessa frase la scrive anche la
-- porta dei sottotask parcheggiati, e lì resta 'service' di proposito: subito
-- dopo arriva una DOMANDA con i suoi bottoni, e promuovere la nota le
-- ruberebbe la cima della card. Quelle righe si riconoscono perché il loro
-- thread contiene una domanda con recinto ```question scritta DOPO, e la
-- condizione qui sotto le esclude.
UPDATE task_comments
   SET kind = 'comment'
 WHERE kind = 'service'
   AND author = 'system'
   AND content = 'Consegna senza riassunto: il turno e'' finito prima che l''agente commentasse.'
   AND NOT EXISTS (
     SELECT 1 FROM task_comments q
      WHERE q.task_id = task_comments.task_id
        AND q.created_at >= task_comments.created_at
        AND q.content LIKE '%```question%'
   );

-- E DEVE ESSERE L'ULTIMA PAROLA, non solo visibile.
--
-- La card mostra l'ultima riga «parlata» del thread. Sulle righe storiche la
-- nota nasceva PRIMA della chiusura del fan-out — stesso timestamp al secondo,
-- rowid consecutivi (18577 e 18578 su `235afe11`) — quindi anche promossa a
-- 'comment' resterebbe sotto, e a schermo continuerebbe a comparire «Fan-out
-- chiuso: 3 tentativi». Il codice nuovo la scrive dopo; qui si ricrea lo stesso
-- ordine sulle righe che c'erano già.
--
-- Un secondo, non di più: sposta la nota dopo le righe scritte dallo stesso
-- giro di consegna e lascia intatto tutto ciò che è venuto dopo davvero. Il
-- `WHERE` la limita alle sole note che hanno una riga di fan-out nel loro
-- stesso secondo — cioè esattamente il caso da riparare.
UPDATE task_comments
   -- `strftime` e non `datetime`: quest'ultima restituisce
   -- '2026-08-20 19:18:16' — spazio al posto della T, niente millisecondi,
   -- niente Z — cioe' un formato che non e' quello con cui l'app scrive e
   -- ordina. Provato su una copia: la riga cambiava valore e l'ordine
   -- restava sbagliato lo stesso.
   SET created_at = strftime('%Y-%m-%dT%H:%M:%f', created_at, '+1 second') || 'Z'
 WHERE kind = 'comment'
   AND author = 'system'
   AND content = 'Consegna senza riassunto: il turno e'' finito prima che l''agente commentasse.'
   AND EXISTS (
     SELECT 1 FROM task_comments f
      WHERE f.task_id = task_comments.task_id
        AND f.content LIKE 'Fan-out chiuso%'
        -- Il confronto e' sul SECONDO, non sull'istante: le due righe
        -- nascono nello stesso giro ma con millisecondi diversi
        -- (…15.403Z e …15.422Z su `235afe11`), quindi un `=` secco non
        -- combaciava mai e la migration non toccava niente. Provato su
        -- copia prima di scriverlo.
        AND substr(f.created_at, 1, 19) = substr(task_comments.created_at, 1, 19)
        AND f.rowid > task_comments.rowid
   );
