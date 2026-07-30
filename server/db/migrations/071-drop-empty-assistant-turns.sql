-- 071: toglie dal thread i turni assistente che non hanno prodotto NIENTE.
--
-- Cosa erano. All'inizio di uno stream il server scrive subito una riga
-- assistente vuota (`partial: 1`) come segnaposto. Fermando il turno PRIMA che
-- il modello dicesse una parola, la finalizzazione dell'abort la marcava
-- `partial: 0` con contenuto vuoto: da quel momento la pulizia che gia'
-- esisteva in `server/routes/history.ts` — che cancella i segnaposto rimasti
-- `partial` — non la vedeva piu'. Restava una bolla vuota fra due turni veri,
-- che sopravvive a ogni reload.
--
-- Al modello non arrivavano: la history verso il provider scarta i turni vuoti
-- (`empty-after-strip` in server/context/assemble.ts, stesso filtro in
-- server/utils/build-provider-history.ts). Il danno e' nel thread salvato e in
-- pagina, non nei token.
--
-- Dal 30/07 non se ne creano piu': `discardIfEmptyTurn` (server/utils.ts)
-- cancella il segnaposto su ENTRAMBE le finalizzazioni — l'endpoint di abort e
-- l'`onAborted` del provider — e la regola di cosa sia "vuoto" e' una sola,
-- `shared/empty-turn.ts`. Questa migration bonifica lo storico.
--
-- Misure sul DB reale (2026-07-30, 170 righe): tutte figlie UNICHE di un
-- messaggio utente, nessuna con fratelli, nessun `active_branches` appeso,
-- nessuna catena vuoto→vuoto, zero costo e zero token registrati, nessun
-- `plan_status`. 158 hanno un figlio (la conversazione e' proseguita dopo lo
-- stop): quel figlio NON si tocca, passa al nonno. 12 sono foglie.
--
-- Il predicato qui sotto e' volutamente PIU' STRETTO della misura: prende solo
-- le forme che sappiamo di saper sistemare. Una riga con fratelli, con un ramo
-- attivo appeso, con del costo registrato o dentro una catena resta dov'e' —
-- su un altro DB potrebbe esistere, e sbagliare qui significa cancellare
-- conversazione vera. Meglio lasciare una bolla vuota che perdere un turno.

CREATE TEMP TABLE turni_muti AS
SELECT m.id AS id, m.parent_id AS parent_id
  FROM messages m
 WHERE m.role = 'assistant'
   AND COALESCE(m.partial, 0) = 0
   -- niente testo, niente ragionamento, niente tool call, niente blocchi, niente media
   AND TRIM(COALESCE(m.content, '')) = ''
   AND TRIM(COALESCE(m.thinking, '')) = ''
   AND COALESCE(m.tool_calls, '[]') IN ('[]', '', 'null')
   AND COALESCE(m.blocks, '[]') IN ('[]', '', 'null')
   AND COALESCE(m.media, '[]') IN ('[]', '', 'null')
   -- niente contabilita' da perdere: se un turno e' costato, resta a memoria
   AND m.plan_status IS NULL
   AND COALESCE(m.cost_cents, 0) = 0
   AND COALESCE(m.usage_prompt_tokens, 0) = 0
   AND COALESCE(m.usage_completion_tokens, 0) = 0
   -- una radice non ha nonno a cui appendere i figli
   AND m.parent_id IS NOT NULL
   -- figlio unico: con dei fratelli, toglierlo vorrebbe dire rinumerare i rami
   AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.parent_id = m.parent_id AND s.id <> m.id)
   -- nessun puntatore di ramo attivo appeso a lui
   AND NOT EXISTS (SELECT 1 FROM active_branches ab WHERE ab.parent_id = m.id);

-- Catene vuoto→vuoto: re-imparentare dentro un insieme che sto per cancellare
-- lascerebbe un figlio appeso a un padre che non c'e' piu'. Nel DB reale non ce
-- ne sono; se altrove ce ne fossero, si tirano fuori entrambi gli anelli e la
-- coppia resta intatta.
CREATE TEMP TABLE catene AS
  SELECT a.id AS id FROM turni_muti a JOIN turni_muti b ON b.parent_id = a.id
  UNION
  SELECT b.id AS id FROM turni_muti a JOIN turni_muti b ON b.parent_id = a.id;

DELETE FROM turni_muti WHERE id IN (SELECT id FROM catene);

-- I figli passano al nonno. `branch_index` NON si tocca: il turno muto era
-- figlio unico, quindi i suoi figli sono gia' numerati 0..n e sotto il nonno
-- restano gli unici — la numerazione e' ancora densa e il puntatore di ramo del
-- nonno (indice 0) continua a indicare una riga che esiste.
UPDATE messages
   SET parent_id = (SELECT t.parent_id FROM turni_muti t WHERE t.id = messages.parent_id)
 WHERE parent_id IN (SELECT id FROM turni_muti);

-- Riferimenti sciolti (nessuna FK): sul DB reale sono tutti a zero, ma un'altra
-- installazione puo' averne. Un marcatore di compattazione punta al messaggio
-- DOPO il quale sta la riga: ereditarlo dal padre lo tiene nello stesso punto
-- del thread. Pin e menzioni su un turno muto non hanno piu' un bersaglio.
UPDATE compaction_markers
   SET after_message_id = (SELECT t.parent_id FROM turni_muti t WHERE t.id = compaction_markers.after_message_id)
 WHERE after_message_id IN (SELECT id FROM turni_muti);

DELETE FROM topic_pinned_messages WHERE message_id IN (SELECT id FROM turni_muti);
DELETE FROM mentions WHERE message_id IN (SELECT id FROM turni_muti);

DELETE FROM messages WHERE id IN (SELECT id FROM turni_muti);

DROP TABLE catene;
DROP TABLE turni_muti;
