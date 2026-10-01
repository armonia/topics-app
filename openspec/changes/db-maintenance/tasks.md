# Tasks: db-maintenance

Nessun passo tocca il DB vivo: i test costruiscono DB sintetici in cartelle
temporanee.

## 1. Un DB nuovo nasce INCREMENTAL (DBMAINT-01)
- [x] Test: `initDatabase` su cartella vuota dà `auto_vacuum = 2` (rosso sulla base)
- [x] `server/db.ts`: `PRAGMA auto_vacuum = INCREMENTAL` prima di ogni tabella, solo su DB nuovo

## 2. Conversione una tantum in `start-prod.sh` (DBMAINT-02)
- [x] Test sul passo vero di `start-prod.sh` contro una cartella dati temporanea: converte, salta con DB aperto, salta con disco stretto, salta con marcatore, già convertito = niente
- [x] `scripts/enable-incremental-vacuum.ts`: lock esclusivo, checkpoint, backup, disco 2×, `VACUUM`, marcatore sul fallimento
- [x] `scripts/start-prod.sh`: il passo prima del ciclo di supervisione, mai bloccante

## 3. Restituzione a riposo nel server (DBMAINT-03)
- [ ] Test del giro: tetto per giro, stop quando occupato, salto con `NONE` o freelist vuota
- [ ] `server/lib/db-incremental-vacuum.ts` + timer in `server.ts` su `whatIsStillWorking()`

## 4. Chiusura
- [ ] Typecheck, lint, `check:*` della CI, `tests/unit`, `review-checks-rails`
