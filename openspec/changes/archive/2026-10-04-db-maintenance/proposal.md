# Change: db-maintenance

> **Stato: APPROVATA** il 01/10/2026 alle 17:10 («vai con tutte le migliori
> soluzione solide usabili comprensibili facili leggibili scalabili pulite
> complete ma sintetiche»). Le scelte sotto sono quelle consigliate.

## Da decidere (deciso)

1. **`auto_vacuum = INCREMENTAL`, non `FULL`** (scelta). `FULL` restituisce le
   pagine a ogni commit, cioè sposta pagine dentro la transazione di chi scrive:
   il costo cade sul turno vivo. `INCREMENTAL` le lascia nella freelist e le
   restituisce chi decidiamo noi, quando decidiamo noi.
2. **Il `VACUUM` una tantum gira in `start-prod.sh`, a server fermo** (scelta).
   Un `VACUUM` di un DB da GB tiene il lock di scrittura per minuti: dentro il
   server fermerebbe ogni turno. Prima dell'avvio non c'è nessuno da fermare.
3. **Il server restituisce le pagine a piccoli passi solo a riposo** (scelta),
   con lo stesso predicato di `restart-when-idle` e un tetto per giro.

## Why

`data/topics.db` pesa diversi GB e dentro ha pagine libere che non tornano mai al
disco: SQLite con `auto_vacuum = NONE` le riusa ma non accorcia il file.
`scripts/compress-message-blobs.ts` lo dice da sé («le pagine liberate restano
DENTRO il file: per restituirle al disco serve `VACUUM` a server fermo»), e
nessuno lo lancia. Con `auto_vacuum` spento non esiste un rimedio che non sia un
`VACUUM` intero; con `INCREMENTAL` basta `PRAGMA incremental_vacuum(N)`, pochi
millisecondi per passo.

Passare un DB esistente a `INCREMENTAL` richiede UN `VACUUM` completo. Va fatto
una volta sola, con il server fermo, e senza mai rischiare il DB.

## What Changes

- Un DB nuovo nasce `INCREMENTAL` (`server/db.ts`): nessun `VACUUM` mai.
- `scripts/enable-incremental-vacuum.ts`, chiamato da `start-prod.sh` prima del
  ciclo di supervisione: se il DB è ancora `NONE` prende il lock esclusivo
  (fallisce subito se qualcuno lo tiene aperto), fa il backup, controlla che il
  disco libero sia almeno 2× la dimensione del DB, e lancia il `VACUUM`. Su
  qualunque condizione non soddisfatta o errore salta, lo dice nel log, e il
  server parte lo stesso. Un `VACUUM` fallito lascia un marcatore e non si
  riprova da solo a ogni avvio.
- `server/lib/db-incremental-vacuum.ts`: ogni 10 minuti, se il server è a riposo
  (`whatIsStillWorking()`), restituisce pagine libere a passi da 512 pagine, al
  massimo 16.384 per giro, e si ferma appena qualcosa riparte.

## Impact

- Codice: `server/db.ts`, `server/lib/db-incremental-vacuum.ts`, `server.ts`,
  `scripts/enable-incremental-vacuum.ts`, `scripts/start-prod.sh`.
- Spec: `schema-integrity` (DBMAINT-01, DBMAINT-02, DBMAINT-03).
- Produzione: la conversione parte al prossimo avvio del supervisore
  (`launchctl kickstart`), non con il ricarico del watcher. Il server resta giù
  per la durata del `VACUUM` (minuti per un DB da GB). Il backup
  `topics.db.pre-incremental-vacuum` resta accanto al DB finché qualcuno non lo
  cestina.
