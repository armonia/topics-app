# D4g — B7, primo pezzo: cosa aspetta il loop quando si ferma

## Barra di B7

Ritardo per frame del mirror con p90 sotto 300 ms, e nessun frame fermo oltre 2 s mentre il loop
principale segnala `[LAG]`.

## Misura (server vivo, 15/10)

- Una sonda esterna chiede `GET /api/system/presence` ogni secondo; se la risposta tarda oltre
  700 ms, il loop è fermo in quel momento e `sample` di macOS cattura gli stack di tutti i thread
  mentre il fermo dura.
- Primo fermo catturato: 844 ms, con 50 ms di CPU del server nel mezzo. Il thread principale era in
  `sqlite3_step` → `sqlite3BtreeNext` → `readDbPage` → `pread`: una query che scorre un b-tree e
  legge pagine dal disco. Nello stack c'è `purgeableCacheFetch`: la SQLite di sistema tiene la cache
  delle pagine in memoria purgeable, che il kernel butta quando la memoria scarseggia, e con lo swap
  che occupa il disco ogni pagina riletta aspetta.
- I `[LAG]` del 15/10 hanno due forme: fame di CPU (load 178-205, `queued=+3314ms` su un fermo di
  1.549 ms) e attese con poca CPU, come quella catturata.

## Fatto

- `server/lib/db-slow-log.ts`: ogni esecuzione di `query`, `prepare` e `run` è cronometrata; sopra
  250 ms scrive `[DB-SLOW] <ms> <metodo> rows=<n> <SQL>`, al massimo una riga al minuto per query,
  con il conto delle altre. Agganciato in `initDatabase` dopo le migration. Requisito `DBSLOW-01`.
- Mutanti, su una copia: senza la guardia del doppio avvolgimento, senza il limite al minuto, senza
  la soglia, senza `run`: rosso in tutti e quattro.

## Trovato e non fatto

- Il Worker per il mirror aspetta il nome della query: se i fermi sono quasi tutti una scansione,
  la correzione è l'indice o togliere la query dal percorso caldo, e vale per tutto il server, non
  solo per il co-browse. Contro la fame di CPU un Worker nello stesso processo non aiuta: quel carico
  è della change `mac-usabile-sotto-carico`.

## Rifiutato

- Alzare `cache_size`: la cache è già di 64 MB, ed è proprio quella che il kernel svuota.
