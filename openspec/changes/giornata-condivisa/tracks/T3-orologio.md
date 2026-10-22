# T3 - Un solo orologio

**GOAL.** Esiste un contatore autorevole unico per tutte le entita', un solo
endpoint di recupero, e lo stream della chat sa dire «da qui a qui manca un pezzo».

## Perche' ora

Oggi ogni dominio ha il suo orologio, o nessuno. `server_seq` esiste **solo**
sulla tabella `ui_state` (verificato sul DB vivo: `MAX(server_seq)=1832460`); la
board non ha versione; i messaggi non hanno sequenza. Senza un contatore unico
non esiste «sono aggiornato fino a X» da mostrare, ne' un recupero solo del
delta, ne' un modo di dire quale di due dispositivi e' avanti. E' il pezzo che
Linear chiama `lastSyncId` e PowerSync tiene nei checkpoint.

Tre conseguenze misurate.

**A. L'allocazione di `server_seq` e' una corsa.** `relocate-pane.ts:152` e le
rotte fanno `SELECT COALESCE(MAX(server_seq),0) AS maxSeq FROM ui_state` per
ogni riga scritta. Due scritture concorrenti leggono lo stesso MAX e producono
due «ultimi» che LWW non sa ordinare, e ogni write paga una sonda sull'indice.
Si corregge con una riga: `UPDATE seq SET v=v+1 RETURNING v`. E' il miglior
rapporto valore/costo di tutto il programma.

**B. Il frame non porta il dato, innesca un refetch.** In
`KanbanBoardPane.tsx` il frame WS scatena `refetch()`, e nel codice ci sono gia'
tre toppe per i sintomi («che il refetch sia una raffica sola», «che la risposta
superata non vinca», un `refetch()` su `visibilitychange`). Misurato sul log di
produzione: 71.746 righe HTTP in 107 ore, di cui **63.255, l'88%**, sono 15
rotte di lettura periodica.

**C. Lo stream della chat non ha numeri.** `stream:content_chunk` porta
`{sessionKey, topicId, content}` e nulla piu'. Un frame perso o una
riconnessione a meta' turno non si ricuciono: `useReconnectCatchUp` rimedia
ricaricando la history intera di ogni pane aperto.

## Cosa cambia

1. `UPDATE seq SET v=v+1 RETURNING v` al posto di ogni `SELECT MAX`.
2. Tabella `oplog(seq INTEGER PRIMARY KEY, entity, entity_id, op, payload, at)`
   scritta nella **stessa transazione SQLite** della mutazione.
3. `sync:since(seq)` come unico endpoint di recupero, che sostituisce le 15
   rotte di lettura periodica.
4. Seq monotono per `(sessionKey, messageId)` sui chunk, ring buffer del turno
   in volo lato server, `stream:catchup { fromSeq }` che manda solo il delta. Il
   meccanismo e' quello di Redis Streams, senza Redis.
5. Il banco che misura i millisecondi fra la scrittura su A e la comparsa su B.
   La soglia della barra si fissa alla prima misura, non prima.

## Barra

- `/usr/bin/grep -rn 'COALESCE(MAX(server_seq)' server/ | wc -l` da' 0.
- `bun scripts/measure-cross-device.ts` ripetibile entro il 10%, con il p95
  sotto la soglia fissata al primo giro.
- Le rotte di lettura periodica scendono sotto il 20% delle righe HTTP in una
  finestra di 24 ore.
- Mutazione: rimettere `SELECT MAX` in un punto fa fallire il banco di T4.

## Fuori

Un CRDT, e qualunque libreria di sync lato client. Il verificatore ha refutato
la tesi del CRDT: il server e' unico e autorevole, serve un contatore.
