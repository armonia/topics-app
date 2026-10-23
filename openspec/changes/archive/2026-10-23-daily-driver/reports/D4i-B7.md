# D4i — B7, secondo pezzo: le due query che `[DB-SLOW]` ha nominato

**Barra prima:** sweep di avvio 1.045 ms, sweep della ripresa 374 e 259 ms ogni 5 minuti, sul
server vivo. **Barra dopo:** `bun test server/db-sweep-plans.test.ts` 3/3, con tre mutanti rossi
(sotto); i test della ripresa e dello sweep di avvio 96/96.

## Misura (server vivo, 15/10)

- La sonda esterna di D4g è rimasta accesa 54 minuti: 18 fermi fra 0,75 e 1,51 s. Nello stesso
  intervallo il server ha usato fra 0 e 210 ms di CPU, mai più del 15% del fermo: il loop
  aspetta, non calcola.
- 11 catture con `sample`. Si agganciano in ritardo e vedono solo la coda di ogni fermo, quindi
  contano le proporzioni, non i totali. Sui 859 ms in cui il thread principale non era fermo in
  `kevent`: SQLite 318 (37%, letture da disco con `pread` più calcolo), JavaScript senza simboli
  305 (36%), il resto chiamate di sistema e cambi di thread. SQLite è la prima voce in 7 catture
  su 11.
- Due query nominate da `[DB-SLOW]`:
  1. `SELECT DISTINCT session_key FROM messages WHERE partial = 1`, all'avvio
     (`server/lib/boot-partial-sweep.ts`): 1.045 ms. Scorre tutto `idx_messages_session` e legge la
     tabella riga per riga per controllare `partial`: 27.580 righe, 13.664 pagine lette su una copia
     del database da 321 MB, e nessuna riga trovata.
  2. L'ultimo messaggio di ogni chat, in `riprendiTurniInterrotti` (`server/lib/ripresa-boot.ts`):
     374 e 259 ms, ogni 5 minuti e 20 s dopo certi eventi. Raggruppa tutte le chat per trovare
     l'ultima riga di ciascuna, poi tiene solo quelle delle ultime 25 ore: 2.464 pagine lette e
     312.987 passi della macchina virtuale per 3 righe.

## Fatto

- Migration `20261015180000-messages-partial-index.sql`: indice parziale `idx_messages_partial`
  su `messages(session_key) WHERE partial = 1`. Lo sweep di avvio lo usa da solo, senza toccare la
  query: sulla copia da 13.664 a 25 pagine, da 110.329 a 7 passi. Crearlo costa 0,47 s una volta,
  al primo avvio dopo il porto; oggi lo sweep costa un secondo a ogni avvio.
- La query della ripresa parte dai messaggi delle ultime 25 ore, attraverso `idx_messages_timestamp`,
  e tiene un messaggio solo se è l'ultima riga della sua chat (un `MAX(rowid)` su
  `idx_messages_session`). Sul database vivo: da 2.464 a 74 pagine, da 312.987 a 1.385 passi, stesse
  righe della query vecchia.
- `server/db-sweep-plans.test.ts` (`DBSLOW-02`): sullo schema di tutte le migration controlla i piani
  delle due query e che la ripresa dia le stesse righe della query di prima, compresa una chat con
  una riga recente seguita da una più vecchia, che resta fuori come prima.
- Mutanti, su una copia: la query vecchia della ripresa, la ripresa senza il filtro dell'ultima
  riga, la migration tolta. Rosso in tutti e tre, ognuno sul suo test.

## Trovato e non fatto

- Il JavaScript senza simboli è l'altro terzo dei fermi: un campione nativo non lo sa nominare. Se
  dopo il porto i fermi restano, il passo è un profilo JS (`--cpu-prof`) mentre la sonda gira.
- In diversi `[LAG]` domina la fame di CPU del Mac (load 178-205): lì nessuna query aiuta, ed è
  della change `mac-usabile-sotto-carico`.
- La barra di B7 (p90 dei frame del mirror sotto 300 ms) non è ancora misurata: serve una sessione
  di co-browse vera mentre la sonda gira.

## Rifiutato

- `INDEXED BY idx_messages_timestamp`, la prima versione: dà lo stesso piano, ma una query che nomina
  un indice si rompe dove l'indice manca (`no such index`), e così si rompevano i test della ripresa
  che costruiscono uno schema loro. La versione correlata arriva allo stesso piano da sola, perché
  l'unico vincolo utilizzabile è l'intervallo sul timestamp.
