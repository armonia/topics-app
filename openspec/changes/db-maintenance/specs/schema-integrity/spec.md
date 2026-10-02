# Delta: schema-integrity (db-maintenance)

## ADDED Requirements

### Requirement: DBMAINT-01 — Un database nuovo nasce con `auto_vacuum = INCREMENTAL`

Il database creato da `initDatabase` SHALL avere `PRAGMA auto_vacuum = 2`
(INCREMENTAL) prima della prima tabella: è l'unico momento in cui si imposta
senza un `VACUUM` completo.

#### Scenario: installazione nuova
- **GIVEN** una cartella dati senza `topics.db`
- **WHEN** `initDatabase` crea il database e applica le migration
- **THEN** `PRAGMA auto_vacuum` SHALL valere 2

### Requirement: DBMAINT-02 — Il `VACUUM` di conversione gira una volta, a server fermo, e non impedisce mai l'avvio

`scripts/start-prod.sh` SHALL lanciare `scripts/enable-incremental-vacuum.ts`
prima del ciclo che avvia il server, e SHALL avviare il server qualunque sia
l'esito. Lo script SHALL convertire un database con `auto_vacuum = NONE` così:
lock esclusivo senza attesa, checkpoint del WAL, backup accanto al DB
(`topics.db.pre-incremental-vacuum`), `PRAGMA auto_vacuum = INCREMENTAL`,
`VACUUM`, checkpoint. SHALL saltare senza toccare il DB quando:

- il database non esiste, o è già `INCREMENTAL`/`FULL`;
- un altro processo lo tiene aperto (il lock esclusivo fallisce);
- il disco libero è meno di 2× la dimensione del DB (file + WAL), misurato
  prima e dopo il backup;
- esiste il marcatore `topics.db.incremental-vacuum-failed`.

Un errore durante il `VACUUM` SHALL lasciare il DB integro (il `VACUUM` è
atomico), scrivere il marcatore con il messaggio, e uscire non-zero; senza
marcatore il `VACUUM` si riproverebbe, costando minuti di server giù, a ogni
avvio.

#### Scenario: conversione riuscita
- **GIVEN** un DB `NONE` con pagine libere e nessun altro processo aperto
- **WHEN** gira il passo di `start-prod.sh`
- **THEN** il DB SHALL essere `INCREMENTAL` con freelist 0 e file più piccolo
- **AND** il backup SHALL esistere con il contenuto di prima

#### Scenario: il server è vivo
- **GIVEN** un'altra connessione aperta sul DB
- **WHEN** gira il passo
- **THEN** il DB SHALL restare `NONE`, nessun backup scritto, e il passo SHALL uscire 0

#### Scenario: disco stretto
- **GIVEN** disco libero inferiore a 2× la dimensione del DB
- **THEN** il DB SHALL restare `NONE` e nessun backup SHALL restare sul disco

### Requirement: DBMAINT-03 — Il server restituisce le pagine libere solo a riposo, a passi limitati

Con `auto_vacuum = INCREMENTAL`, il server SHALL eseguire
`PRAGMA incremental_vacuum(512)` a passi, cedendo l'event loop fra un passo e
l'altro, al massimo 16.384 pagine per giro, un giro ogni 10 minuti. Prima di
OGNI passo SHALL chiedere `whatIsStillWorking()` (il predicato di
`restart-when-idle`) e fermarsi se qualcosa lavora. Con `auto_vacuum` diverso da
INCREMENTAL, o freelist vuota, il giro SHALL non scrivere niente.

#### Scenario: a riposo con pagine libere
- **GIVEN** un DB INCREMENTAL con più pagine libere del tetto
- **WHEN** gira un giro a riposo
- **THEN** SHALL restituire esattamente il tetto, a passi da 512

#### Scenario: un turno parte a metà giro
- **WHEN** il predicato dice «occupato» dopo il primo passo
- **THEN** il giro SHALL fermarsi dopo quel passo

#### Scenario: DB non ancora convertito
- **GIVEN** `auto_vacuum = NONE`
- **THEN** il giro SHALL saltare senza eseguire `incremental_vacuum`
