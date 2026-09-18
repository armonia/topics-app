-- 20260918134053-registro-senza-righe-fantasma.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- UNA RIGA DEL REGISTRO NON CORRISPONDE A NESSUNA MIGRATION.
--
-- `schema_migrations` ha, su ogni database di questo progetto, una riga
-- `(100, 'push-device-prefs')` che non è un file. Viene dall'INSERT interno di
-- `101-push-device-prefs.sql`, che si auto-registra e porta ancora il numero
-- che il file aveva PRIMA di essere rinumerato: nacque 100, main si prese
-- quel numero con `100-task-labels.sql`, il file diventò 101 e il suo INSERT
-- rimase a 100. Lo racconta il commento in testa a
-- `20260812094300-notification-log.sql`, che fu rinumerata nella stessa notte.
--
-- PERCHÉ NON È SOLO COSMESI. Il runner ripulisce gli stem storici delle altre
-- cinque migration che si registrano da sole (003, 004, 005, 006, 007) con
-- `DELETE ... WHERE version = ? AND name NOT LIKE '%.sql'`, dove `?` è il
-- numero DEL FILE. Per questa lo stem è archiviato sotto 100 e il file è 101:
-- la pulizia guarda il numero sbagliato e non la trova mai. La riga sopravvive
-- e occupa il numero 100 insieme a `100-task-labels.sql`, quindi ogni lettore
-- che interroga il registro per VERSIONE trova due righe dove ce n'è una sola
-- vera (`scripts/board-baseline.ts` legge così la soglia 048; oggi è un'altra
-- versione, domani è una riga in più a un `GROUP BY`). E se un database
-- ereditasse ancora la forma vecchia con `version` come chiave primaria,
-- quell'INSERT fallirebbe con UNIQUE constraint: verificato, `sqlite3` esce
-- con errore. Oggi non accade perché la chiave è sul nome.
--
-- LA CURA È QUI E NON NEL FILE 101: quella migration è APPLICATA su ogni
-- database vivo, quindi non gira più e modificarla cambierebbe soltanto la
-- storia dei database NUOVI, lasciando divergere i due. Una migration nuova
-- ripara entrambi con lo stesso SQL.
--
-- La condizione è stretta di proposito: cancella le righe che non sono nomi di
-- file e il cui stem corrisponde a una migration che RISULTA GIÀ APPLICATA col
-- suo nome vero. Se per qualunque ragione `101-push-device-prefs.sql` non
-- fosse registrata, questa riga resta dov'è e nessuno perde la traccia che
-- quella migration è passata.

DELETE FROM schema_migrations
 WHERE name NOT LIKE '%.sql'
   AND EXISTS (
     SELECT 1 FROM schema_migrations vera
      WHERE vera.name LIKE '%.sql'
        AND vera.name LIKE '%-' || schema_migrations.name || '.sql'
   );
