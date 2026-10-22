# T2 - Il DB ha un backup provato da un restore

**GOAL.** Ogni giorno esiste uno snapshot del DB verificato da un restore vero,
una copia sta fuori dal disco del DB, e le copie a mano non governate sono potate.

## Perche' ora

`data/topics.db` pesa 307 MB con 1.908 topic, 27.644 messaggi, 5.334 task e 188
migration applicate. In `server/`, `scripts/`, `shared/` e `server.ts`, esclusi i
test, non esiste `VACUUM INTO`, ne' `integrity_check`, ne' `quick_check`, e
nessun launchd fa snapshot. L'unico periodico e' parziale: `ui-state-backup.ts`
salva ogni 5 minuti la sola tabella `ui_state`.

L'ultimo backup completo e' `data/backups/topics-2026-10-14.db.zst`, 8 giorni
prima, **sullo stesso disco**. `tmutil destinationinfo` dice «No destinations
configured». Riparazioni reali sono gia' avvenute: `prima-riparazione-06519a5d.db`
del 10/09, `topics-pre-partial-repair-20260905-111725.db`.

Il problema vero e' l'opposto di «manca un backup»: ce ne sono troppi e non
governati. `~/.topics/backups` pesa 4,6 GB, `~/.topics/db-backups` 614 MB con
permessi 0644, contro la regola scritta «uno solo, poi trash». Il divieto in
`docs/backup-pre-migration-policy.md` riguarda la cancellazione dei backup
pre-migration di `data/`, non gli snapshot periodici: va riscritto per dirlo.

E c'e' una trappola del dev loop: con `TOPICS_SERVER_WATCH=1` creare
`server/db/migrations/NNN-*.sql` applica quella migration al DB **vivo** in
pochi secondi. Senza backup giornaliero, una migration di dati sbagliata non ha
ritorno.

## Cosa cambia

1. Job launchd giornaliero: `VACUUM INTO` su file temporaneo, zstd, rename
   atomico in `data/backups`.
2. Verifica automatica subito dopo: `integrity_check` piu' `initDatabase` su una
   copia scratch, che deve arrivare a 188 migration.
3. Retention 14 giornalieri piu' 8 settimanali. Una copia fuori dal disco, sul
   PC Windows o in cloud.
4. `PRAGMA quick_check` settimanale.
5. Potatura con `trash` delle copie a mano dopo il primo snapshot verificato, e
   `backup-pre-migration-policy.md` riscritta per distinguere i due casi.

## Barra

- `bun scripts/backup-restore-check.ts` esce 0 solo se la copia piu' recente si
  decomprime, `integrity_check=ok`, e `initDatabase` la porta a 188 migration.
- `find data/backups -name 'topics-*.db.zst' -mtime -1 | wc -l` almeno 1.
- Una copia esiste su un disco diverso da quello del DB, verificata dallo script.

## Fuori

Un archivio freddo o uno sharding del DB. SQLite a 307 MB con un solo scrittore
non e' il collo di bottiglia: la mappa dati lo dice con 865/937 statement puliti.
